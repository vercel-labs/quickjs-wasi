import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ObjectInspector, chromeDark } from 'react-inspector';
import { QuickJS, JSException, type JSValueHandle } from 'quickjs-wasi';
import { Play, Loader2, Globe, Terminal } from 'lucide-react';
import { Button } from './src/components/ui/button';
import { Switch } from './src/components/ui/switch';
import { Badge } from './src/components/ui/badge';
import { cn } from './src/lib/utils';

import './src/index.css';

// Inspector theme matching our dark UI
const inspectorTheme = {
  ...chromeDark,
  BASE_FONT_FAMILY: "var(--font-mono)",
  BASE_FONT_SIZE: '13px',
  BASE_BACKGROUND_COLOR: 'transparent',
  TREENODE_FONT_FAMILY: "var(--font-mono)",
  TREENODE_FONT_SIZE: '13px',
} as unknown as string;

type OutputResult = { type: 'result'; value: unknown };
type OutputLog = { type: 'log'; values: unknown[] };
type OutputError = { type: 'error'; text: string };
type OutputEntry = OutputResult | OutputLog | OutputError;

const DEFAULT_CODE = `// Try any JavaScript \u2014 it runs in a sandboxed QuickJS VM
const obj = {
  name: "QuickJS",
  version: "2024.2",
  features: ["ES2023", "modules", "BigInt"],
  nested: { a: 1, b: [2, 3, { c: true }] },
};

console.log("Hello from QuickJS!", obj);
obj;`;

function OutputEntryView({ entry }: { entry: OutputEntry }) {
  if (entry.type === 'result') {
    return (
      <div className="flex gap-2 py-0.5">
        <span className="text-emerald-400 select-none shrink-0">&larr;</span>
        <div className="text-emerald-400 min-w-0">
          <ObjectInspector data={entry.value} theme={inspectorTheme} expandLevel={1} />
        </div>
      </div>
    );
  }

  if (entry.type === 'log') {
    return (
      <div className="flex gap-2 py-0.5 text-muted-foreground">
        <span className="select-none shrink-0">&gt;</span>
        <div className="min-w-0">
          {entry.values.map((v, i) => (
            <span key={i} className="align-top">
              {i > 0 && ' '}
              {typeof v === 'object' && v !== null ? (
                <ObjectInspector data={v} theme={inspectorTheme} expandLevel={0} />
              ) : (
                String(v)
              )}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (entry.type === 'error') {
    return (
      <div className="flex gap-2 py-0.5">
        <span className="text-destructive select-none shrink-0">!</span>
        <span className="text-destructive whitespace-pre-wrap">{entry.text}</span>
      </div>
    );
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

      // Provide console.log / console.error
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

      // Evaluate
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
      setStatus(`${elapsed}ms`);

      vm.dispose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entries.push({ type: 'error', text: `Host error: ${message}` });
      setStatus('Execution failed');
    } finally {
      setOutput(entries);
      setRunning(false);
    }
  }, [urlExtEnabled]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Handle Tab key for indentation
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    },
    [run]
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
            <Terminal className="w-5 h-5" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            quickjs-wasi
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          QuickJS running in the browser via WebAssembly
        </p>
      </div>

      {/* Editor Card */}
      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-lg">
        {/* Editor Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/80">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">Editor</span>
            <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0">
              ES2023
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground/60 hidden sm:inline">
            {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to run
          </span>
        </div>

        {/* Textarea */}
        <textarea
          ref={codeRef}
          defaultValue={DEFAULT_CODE}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          className={cn(
            "w-full h-56 sm:h-64 resize-y p-4",
            "bg-background text-foreground",
            "font-mono text-sm leading-relaxed",
            "border-none outline-none",
            "placeholder:text-muted-foreground/40",
          )}
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-card/80">
          <div className="flex items-center gap-4">
            <Button
              onClick={run}
              disabled={!wasmReady || running}
              size="sm"
              className="gap-1.5"
            >
              {running ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {wasmReady ? 'Run' : 'Loading...'}
            </Button>

            {/* URL Extension Toggle */}
            <div className="flex items-center gap-2">
              <Switch
                checked={urlExtEnabled}
                onCheckedChange={handleUrlExtToggle}
                aria-label="Enable URL extension"
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none" onClick={() => handleUrlExtToggle(!urlExtEnabled)}>
                <Globe className="w-3.5 h-3.5" />
                <span>URL extension</span>
              </label>
            </div>
          </div>

          {status && (
            <Badge variant="success" className="text-[10px] font-mono">
              {status}
            </Badge>
          )}
        </div>
      </div>

      {/* Output */}
      {output.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-card overflow-hidden shadow-lg">
          <div className="px-4 py-2.5 border-b border-border bg-card/80">
            <span className="text-sm font-medium text-muted-foreground">Output</span>
          </div>
          <div
            ref={outputRef}
            className="p-4 font-mono text-[13px] leading-relaxed max-h-96 overflow-y-auto"
          >
            {output.map((entry, i) => (
              <OutputEntryView key={i} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
