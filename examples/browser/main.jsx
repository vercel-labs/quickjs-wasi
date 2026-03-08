import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Inspector, chromeDark } from 'react-inspector';
import { QuickJS } from 'quickjs-wasi';

// Custom dark theme for react-inspector extending chromeDark
const inspectorTheme = {
  ...chromeDark,
  BASE_FONT_FAMILY: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  BASE_FONT_SIZE: '13px',
  BASE_BACKGROUND_COLOR: 'transparent',
  TREENODE_FONT_FAMILY: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  TREENODE_FONT_SIZE: '13px',
};

function OutputEntry({ entry }) {
  if (entry.type === 'result') {
    return (
      <div className="output-entry result">
        <Inspector data={entry.value} theme={inspectorTheme} expandLevel={1} />
      </div>
    );
  }

  if (entry.type === 'log') {
    return (
      <div className="output-entry log">
        {entry.values.map((v, i) => (
          <span key={i}>
            {i > 0 && ' '}
            {typeof v === 'object' && v !== null ? (
              <Inspector data={v} theme={inspectorTheme} expandLevel={0} />
            ) : (
              String(v)
            )}
          </span>
        ))}
      </div>
    );
  }

  if (entry.type === 'error') {
    return <div className="output-entry error">{entry.text}</div>;
  }

  return null;
}

function App() {
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState([]);
  const [wasmReady, setWasmReady] = useState(false);
  const wasmModuleRef = useRef(null);
  const codeRef = useRef(null);
  const outputRef = useRef(null);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Load WASM on mount
  useEffect(() => {
    async function init() {
      try {
        const response = await fetch('/quickjs.wasm');
        const bytes = await response.arrayBuffer();
        wasmModuleRef.current = await WebAssembly.compile(bytes);
        setWasmReady(true);
        setStatus(`WASM loaded (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
      } catch (err) {
        setStatus(`Failed to load WASM: ${err.message}`);
        setOutput([{ type: 'error', text: `Error loading WASM: ${err.message}` }]);
      }
    }
    init();
  }, []);

  const run = useCallback(async () => {
    const code = codeRef.current.value;
    setOutput([]);
    setRunning(true);

    const entries = [];
    const start = performance.now();

    try {
      const execStart = Date.now();
      const vm = await QuickJS.create({
        wasm: wasmModuleRef.current,
        memoryLimit: 8 * 1024 * 1024,
        interruptHandler: () => Date.now() - execStart > 5000,
      });

      // Provide console.log / console.error via host functions
      {
        const log = vm.newFunction('log', (...args) => {
          const values = args.map((a) => vm.dump(a));
          entries.push({ type: 'log', values });
          return vm.undefined;
        });
        const error = vm.newFunction('error', (...args) => {
          const text = args.map((a) => vm.dump(a)).map(String).join(' ');
          entries.push({ type: 'error', text });
          return vm.undefined;
        });
        const consoleObj = vm.newObject();
        consoleObj.setProp('log', log);
        consoleObj.setProp('error', error);
        vm.setProp(vm.global, 'console', consoleObj);
        log.dispose();
        error.dispose();
        consoleObj.dispose();
      }

      // Evaluate the user's code
      const result = vm.evalCode(code);

      if (result.isException) {
        const exc = vm.getException();
        const dumped = vm.dump(exc);
        exc.dispose();
        if (dumped instanceof Error) {
          entries.push({ type: 'error', text: `${dumped.name}: ${dumped.message}` });
          if (dumped.stack) entries.push({ type: 'error', text: dumped.stack });
        } else {
          entries.push({ type: 'error', text: String(dumped) });
        }
      } else {
        const value = vm.dump(result);
        if (value !== undefined) {
          entries.push({ type: 'result', value });
        }
      }

      result.dispose();

      const elapsed = (performance.now() - start).toFixed(1);
      setStatus(`Executed in ${elapsed}ms`);

      vm.dispose();
    } catch (err) {
      entries.push({ type: 'error', text: `Host error: ${err.message}` });
      setStatus('Execution failed');
    } finally {
      setOutput(entries);
      setRunning(false);
    }
  }, []);

  const handleKeyDown = useCallback(
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    },
    [run]
  );

  return (
    <>
      <h1>quickjs-wasi</h1>
      <p className="subtitle">QuickJS running in the browser via WebAssembly</p>

      <label htmlFor="code">JavaScript code:</label>
      <textarea
        id="code"
        ref={codeRef}
        defaultValue={`// Try any JavaScript — it runs in a sandboxed QuickJS VM
const obj = {
  name: "QuickJS",
  version: "2024.2",
  features: ["ES2023", "modules", "BigInt"],
  nested: { a: 1, b: [2, 3, { c: true }] },
};

console.log("Hello from QuickJS!", obj);
obj;`}
        onKeyDown={handleKeyDown}
      />

      <button id="run" disabled={!wasmReady || running} onClick={run}>
        {wasmReady ? 'Run' : 'Loading WASM...'}
      </button>

      <div id="output" ref={outputRef}>
        {output.map((entry, i) => (
          <OutputEntry key={i} entry={entry} />
        ))}
      </div>
      <div id="status">{status}</div>
    </>
  );
}

createRoot(document.getElementById('app')).render(<App />);
