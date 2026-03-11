import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ObjectInspector, chromeDark } from 'react-inspector';
import { QuickJS, JSException, type JSValueHandle } from 'quickjs-wasi';

import './fonts.css';

// Extend chromeDark with a transparent background and matching monospace font.
// react-inspector v9 types `theme` as `string` but accepts objects at runtime.
const inspectorTheme = {
  ...chromeDark,
  BASE_FONT_FAMILY: "'Geist Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  BASE_FONT_SIZE: '13px',
  BASE_BACKGROUND_COLOR: 'transparent',
  TREENODE_FONT_FAMILY: "'Geist Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  TREENODE_FONT_SIZE: '13px',
} as unknown as string;

type OutputResult = { type: 'result'; value: unknown };
type OutputLog = { type: 'log'; values: unknown[] };
type OutputError = { type: 'error'; text: string };
type OutputEntry = OutputResult | OutputLog | OutputError;

function OutputEntryView({ entry }: { entry: OutputEntry }) {
  if (entry.type === 'result') {
    return (
      <div className="output-entry result">
        <ObjectInspector data={entry.value} theme={inspectorTheme} expandLevel={1} />
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
              <ObjectInspector data={v} theme={inspectorTheme} expandLevel={0} />
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
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [wasmReady, setWasmReady] = useState(false);
  const [urlExtEnabled, setUrlExtEnabled] = useState(false);
  const wasmModuleRef = useRef<WebAssembly.Module | null>(null);
  const urlExtBytesRef = useRef<ArrayBuffer | null>(null);
  const codeRef = useRef<HTMLTextAreaElement | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

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
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Failed to load WASM: ${message}`);
        setOutput([{ type: 'error', text: `Error loading WASM: ${message}` }]);
      }
    }
    init();
  }, []);

  // Lazily fetch the URL extension binary on first enable
  const handleUrlExtToggle = useCallback(async (checked: boolean) => {
    setUrlExtEnabled(checked);
    if (checked && !urlExtBytesRef.current) {
      try {
        const response = await fetch('/url.so');
        urlExtBytesRef.current = await response.arrayBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setOutput([{ type: 'error', text: `Failed to load URL extension: ${message}` }]);
        setUrlExtEnabled(false);
      }
    }
  }, []);

  const run = useCallback(async () => {
    const code = codeRef.current?.value;
    if (!code) return;
    setOutput([]);
    setRunning(true);

    const entries: OutputEntry[] = [];
    const start = performance.now();

    try {
      const execStart = Date.now();
      const extensions = urlExtEnabled && urlExtBytesRef.current
        ? [{ name: 'url', wasm: new Uint8Array(urlExtBytesRef.current) }]
        : [];
      const vm = await QuickJS.create({
        wasm: wasmModuleRef.current!,
        memoryLimit: 8 * 1024 * 1024,
        interruptHandler: () => Date.now() - execStart > 5000,
        extensions,
      });

      // Provide console.log / console.error via host functions
      {
        const log = vm.newFunction('log', function (this: JSValueHandle, ...args: JSValueHandle[]) {
          const values = args.map((a) => vm.dump(a));
          entries.push({ type: 'log', values });
          return vm.undefined;
        });
        const error = vm.newFunction('error', function (this: JSValueHandle, ...args: JSValueHandle[]) {
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
      try {
        const result = vm.evalCode(code);
        const value = vm.dump(result);
        if (value !== undefined) {
          entries.push({ type: 'result', value });
        }
        result.dispose();
      } catch (evalErr) {
        if (evalErr instanceof JSException) {
          const dumped = vm.dump(evalErr.handle);
          evalErr.handle.dispose();
          if (dumped instanceof Error) {
            entries.push({ type: 'error', text: `${dumped.name}: ${dumped.message}` });
            if (dumped.stack) entries.push({ type: 'error', text: dumped.stack });
          } else {
            entries.push({ type: 'error', text: String(dumped) });
          }
        } else {
          throw evalErr;
        }
      }

      const elapsed = (performance.now() - start).toFixed(1);
      setStatus(`Executed in ${elapsed}ms`);

      vm.dispose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entries.push({ type: 'error', text: `Host error: ${message}` });
      setStatus('Execution failed');
    } finally {
      setOutput(entries);
      setRunning(false);
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
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

      <div className="toolbar">
        <button id="run" disabled={!wasmReady || running} onClick={run}>
          {wasmReady ? 'Run' : 'Loading WASM...'}
        </button>
        <label className="ext-toggle">
          <input
            type="checkbox"
            checked={urlExtEnabled}
            onChange={(e) => handleUrlExtToggle(e.target.checked)}
          />
          URL extension
        </label>
      </div>

      <div id="output" ref={outputRef}>
        {output.map((entry, i) => (
          <OutputEntryView key={i} entry={entry} />
        ))}
      </div>
      <div id="status">{status}</div>
    </>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
