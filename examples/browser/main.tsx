import { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { ObjectInspector, chromeDark } from 'react-inspector';
import { QuickJS, JSException, type JSValueHandle } from 'quickjs-wasi';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import { initVimMode } from 'monaco-vim';
import { Play, Loader2, Globe, Terminal, Type } from 'lucide-react';
import { Button } from './src/components/ui/button';
import { Switch } from './src/components/ui/switch';
import { Badge } from './src/components/ui/badge';

import './src/index.css';

// ─── localStorage helpers ────────────────────────────────────────────────────

const STORAGE_KEYS = {
  code: 'qjs-playground:code',
  urlExt: 'qjs-playground:urlExt',
  encodingExt: 'qjs-playground:encodingExt',
  vim: 'qjs-playground:vim',
} as const;

function loadString(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch { return fallback; }
}

function save(key: string, value: string | boolean) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

// ─── URL / URLSearchParams type definitions ──────────────────────────────────

const URL_TYPE_DEFS = `
/** The URL interface represents an object providing static methods for creating object URLs. */
declare class URL {
  constructor(url: string | URL, base?: string | URL);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  username: string;
  toString(): string;
  toJSON(): string;
  static canParse(url: string | URL, base?: string): boolean;
}

/** The URLSearchParams interface defines utility methods to work with the query string of a URL. */
declare class URLSearchParams {
  constructor(init?: string | URLSearchParams | Record<string, string> | [string, string][]);
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(callbackfn: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
}
`;

// ─── TextEncoder / TextDecoder type definitions ─────────────────────────────

const ENCODING_TYPE_DEFS = `
/** The TextEncoder interface encodes a string into a Uint8Array containing UTF-8 encoded text. */
declare class TextEncoder {
  constructor();
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

/** The TextDecoder interface decodes bytes into a string using a specified encoding. */
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
`;

// ─── Constants ───────────────────────────────────────────────────────────────

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

// ─── Output rendering ────────────────────────────────────────────────────────

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

// ─── App ─────────────────────────────────────────────────────────────────────

const URL_TYPES_URI = 'ts:url-extension/url.d.ts';
const ENCODING_TYPES_URI = 'ts:encoding-extension/encoding.d.ts';

function App() {
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [wasmReady, setWasmReady] = useState(false);
  const [urlExtEnabled, setUrlExtEnabled] = useState(() => loadBool(STORAGE_KEYS.urlExt, false));
  const [encodingExtEnabled, setEncodingExtEnabled] = useState(() => loadBool(STORAGE_KEYS.encodingExt, false));
  const [vimEnabled, setVimEnabled] = useState(() => loadBool(STORAGE_KEYS.vim, false));
  const wasmModuleRef = useRef<WebAssembly.Module | null>(null);
  const urlExtBytesRef = useRef<ArrayBuffer | null>(null);
  const encodingExtBytesRef = useRef<ArrayBuffer | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const vimModeRef = useRef<ReturnType<typeof initVimMode> | null>(null);
  const vimStatusRef = useRef<HTMLDivElement | null>(null);
  const urlTypesDisposableRef = useRef<{ dispose(): void } | null>(null);
  const encodingTypesDisposableRef = useRef<{ dispose(): void } | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  // Persist checkbox states
  useEffect(() => { save(STORAGE_KEYS.urlExt, urlExtEnabled); }, [urlExtEnabled]);
  useEffect(() => { save(STORAGE_KEYS.encodingExt, encodingExtEnabled); }, [encodingExtEnabled]);
  useEffect(() => { save(STORAGE_KEYS.vim, vimEnabled); }, [vimEnabled]);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Load WASM on mount (and URL extension binary if persisted as enabled)
  useEffect(() => {
    async function init() {
      try {
        const fetches: Promise<ArrayBuffer>[] = [
          fetch('/quickjs.wasm').then((r) => r.arrayBuffer()),
        ];
        // Pre-fetch extensions if they were enabled in a previous session
        if (urlExtEnabled && !urlExtBytesRef.current) {
          fetches.push(fetch('/url.so').then((r) => r.arrayBuffer()));
        }
        if (encodingExtEnabled && !encodingExtBytesRef.current) {
          fetches.push(fetch('/encoding.so').then((r) => r.arrayBuffer()));
        }
        const [wasmBytes, ...extBytes] = await Promise.all(fetches);
        wasmModuleRef.current = await WebAssembly.compile(wasmBytes);
        let extIdx = 0;
        if (urlExtEnabled && !urlExtBytesRef.current && extBytes[extIdx]) {
          urlExtBytesRef.current = extBytes[extIdx++];
        }
        if (encodingExtEnabled && !encodingExtBytesRef.current && extBytes[extIdx]) {
          encodingExtBytesRef.current = extBytes[extIdx++];
        }
        setWasmReady(true);
        setStatus(`WASM loaded (${(wasmBytes.byteLength / 1024).toFixed(0)} KB)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Failed to load WASM: ${message}`);
        setOutput([{ type: 'error', text: `Error loading WASM: ${message}` }]);
      }
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- urlExtEnabled read only for initial value

  // Vim mode: managed entirely via editorMounted + vimEnabled
  // We track editorMounted as state so this effect re-runs once the editor is ready.
  const [editorMounted, setEditorMounted] = useState(false);

  useEffect(() => {
    if (!editorRef.current) return;
    if (vimEnabled) {
      vimModeRef.current = initVimMode(editorRef.current, vimStatusRef.current);
    } else {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
    }
    return () => {
      vimModeRef.current?.dispose();
      vimModeRef.current = null;
    };
  }, [vimEnabled, editorMounted]);

  // URL extension types: add/remove type definitions in Monaco
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (urlExtEnabled) {
      // Add URL type definitions as an extra lib
      urlTypesDisposableRef.current = monaco.languages.typescript.javascriptDefaults.addExtraLib(
        URL_TYPE_DEFS,
        URL_TYPES_URI,
      );
    } else {
      urlTypesDisposableRef.current?.dispose();
      urlTypesDisposableRef.current = null;
    }

    return () => {
      urlTypesDisposableRef.current?.dispose();
      urlTypesDisposableRef.current = null;
    };
  }, [urlExtEnabled]);

  // Encoding extension types: add/remove type definitions in Monaco
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (encodingExtEnabled) {
      encodingTypesDisposableRef.current = monaco.languages.typescript.javascriptDefaults.addExtraLib(
        ENCODING_TYPE_DEFS,
        ENCODING_TYPES_URI,
      );
    } else {
      encodingTypesDisposableRef.current?.dispose();
      encodingTypesDisposableRef.current = null;
    }

    return () => {
      encodingTypesDisposableRef.current?.dispose();
      encodingTypesDisposableRef.current = null;
    };
  }, [encodingExtEnabled]);

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

  // Lazily fetch the Encoding extension binary on first enable
  const handleEncodingExtToggle = useCallback(async (checked: boolean) => {
    setEncodingExtEnabled(checked);
    if (checked && !encodingExtBytesRef.current) {
      try {
        const response = await fetch('/encoding.so');
        encodingExtBytesRef.current = await response.arrayBuffer();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setOutput([{ type: 'error', text: `Failed to load Encoding extension: ${message}` }]);
        setEncodingExtEnabled(false);
      }
    }
  }, []);

  // Use a ref so that the Monaco keybinding action always calls the latest
  // version of run() without needing to re-register the action on every render.
  const runRef = useRef<() => void>(() => {});

  const run = useCallback(async () => {
    const code = editorRef.current?.getValue();
    if (!code) return;
    setOutput([]);
    setRunning(true);

    const entries: OutputEntry[] = [];
    const start = performance.now();

    try {
      const execStart = Date.now();
      const extensions: { name: string; wasm: Uint8Array }[] = [];
      if (urlExtEnabled && urlExtBytesRef.current) {
        extensions.push({ name: 'url', wasm: new Uint8Array(urlExtBytesRef.current) });
      }
      if (encodingExtEnabled && encodingExtBytesRef.current) {
        extensions.push({ name: 'encoding', wasm: new Uint8Array(encodingExtBytesRef.current) });
      }
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
  }, [urlExtEnabled, encodingExtEnabled]);

  // Keep the ref in sync with the latest run callback
  runRef.current = run;

  // Configure Monaco before it mounts: strip down to barebones JS (no DOM, no Node)
  const handleEditorWillMount: BeforeMount = useCallback((monaco) => {
    monacoRef.current = monaco;

    const jsDefaults = monaco.languages.typescript.javascriptDefaults;

    // Include core ES lib types (String, Array, Promise, Map, etc.)
    // but exclude DOM and Node types since this is a QuickJS sandbox
    jsDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      lib: ['es2022'],
      allowJs: true,
      checkJs: false,
      allowNonTsExtensions: true,
    });

    // Add console declaration (not part of ES spec, provided by our host)
    jsDefaults.addExtraLib(
      `
      declare var console: {
        log(...args: any[]): void;
        error(...args: any[]): void;
      };
      `,
      'ts:quickjs-env/globals.d.ts',
    );

    // If extensions were persisted as enabled, add types immediately
    if (loadBool(STORAGE_KEYS.urlExt, false)) {
      urlTypesDisposableRef.current = jsDefaults.addExtraLib(URL_TYPE_DEFS, URL_TYPES_URI);
    }
    if (loadBool(STORAGE_KEYS.encodingExt, false)) {
      encodingTypesDisposableRef.current = jsDefaults.addExtraLib(ENCODING_TYPE_DEFS, ENCODING_TYPES_URI);
    }

    // Disable validation noise for a playground
    jsDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Cmd/Ctrl+Enter to run - calls through ref so it always uses the latest run()
    editor.addAction({
      id: 'run-code',
      label: 'Run Code',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => { runRef.current(); },
    });

    // Save editor content to localStorage on change (debounced)
    let saveTimer: ReturnType<typeof setTimeout>;
    editor.onDidChangeModelContent(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        save(STORAGE_KEYS.code, editor.getValue());
      }, 500);
    });

    // Signal that the editor is ready so the vim effect can run
    setEditorMounted(true);
  }, []);

  const savedCode = loadString(STORAGE_KEYS.code, DEFAULT_CODE);

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

        {/* Monaco Editor */}
        <Editor
          height="280px"
          defaultLanguage="javascript"
          defaultValue={savedCode}
          theme="vs-dark"
          beforeMount={handleEditorWillMount}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
            fontLigatures: true,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            scrollbar: {
              vertical: 'hidden',
              horizontal: 'hidden',
            },
            tabSize: 2,
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />

        {/* Vim status bar (hidden unless vim mode enabled) */}
        <div
          ref={vimStatusRef}
          className={`px-4 py-1 font-mono text-xs text-muted-foreground border-t border-border bg-background ${vimEnabled ? '' : 'hidden'}`}
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

            {/* Divider */}
            <div className="h-5 w-px bg-border" />

            {/* URL Extension Toggle */}
            <div className="flex items-center gap-2">
              <Switch
                checked={urlExtEnabled}
                onCheckedChange={handleUrlExtToggle}
                aria-label="Enable URL extension"
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none" onClick={() => handleUrlExtToggle(!urlExtEnabled)}>
                <Globe className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">URL</span>
              </label>
            </div>

            {/* Encoding Extension Toggle */}
            <div className="flex items-center gap-2">
              <Switch
                checked={encodingExtEnabled}
                onCheckedChange={handleEncodingExtToggle}
                aria-label="Enable Encoding extension"
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none" onClick={() => handleEncodingExtToggle(!encodingExtEnabled)}>
                <Type className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Encoding</span>
              </label>
            </div>

            {/* Vim Toggle */}
            <div className="flex items-center gap-2">
              <Switch
                checked={vimEnabled}
                onCheckedChange={setVimEnabled}
                aria-label="Enable Vim mode"
              />
              <label className="text-xs text-muted-foreground cursor-pointer select-none" onClick={() => setVimEnabled(!vimEnabled)}>
                Vim
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
