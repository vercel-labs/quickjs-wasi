import { QuickJS } from 'quickjs-wasi';

const codeEl = document.getElementById('code');
const runBtn = document.getElementById('run');
const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');

function appendOutput(text, className = 'log') {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text + '\n';
  outputEl.appendChild(span);
  outputEl.scrollTop = outputEl.scrollHeight;
}

// Load the WASM module once at startup
let wasmModule;

async function init() {
  try {
    const response = await fetch('/quickjs.wasm');
    const bytes = await response.arrayBuffer();
    wasmModule = await WebAssembly.compile(bytes);
    runBtn.textContent = 'Run';
    runBtn.disabled = false;
    statusEl.textContent = `WASM loaded (${(bytes.byteLength / 1024).toFixed(0)} KB)`;
  } catch (err) {
    statusEl.textContent = `Failed to load WASM: ${err.message}`;
    appendOutput(`Error loading WASM: ${err.message}`, 'error');
  }
}

async function run() {
  const code = codeEl.value;
  outputEl.innerHTML = '';
  runBtn.disabled = true;

  const start = performance.now();

  try {
    // Create a fresh VM for each execution with a 5-second timeout
    const execStart = Date.now();
    const vm = await QuickJS.create({
      wasm: wasmModule,
      memoryLimit: 8 * 1024 * 1024, // 8 MB
      interruptHandler: () => Date.now() - execStart > 5000,
    });

    // Provide console.log / console.error via host functions
    {
      const log = vm.newFunction('log', (...args) => {
        appendOutput(args.map(a => vm.dump(a)).map(String).join(' '), 'log');
        return vm.undefined;
      });
      const error = vm.newFunction('error', (...args) => {
        appendOutput(args.map(a => vm.dump(a)).map(String).join(' '), 'error');
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
        appendOutput(`${dumped.name}: ${dumped.message}`, 'error');
        if (dumped.stack) appendOutput(dumped.stack, 'error');
      } else {
        appendOutput(String(dumped), 'error');
      }
    } else {
      const value = vm.dump(result);
      if (value !== undefined) {
        appendOutput(String(value), 'result');
      }
    }

    result.dispose();

    const elapsed = (performance.now() - start).toFixed(1);
    statusEl.textContent = `Executed in ${elapsed}ms`;

    vm.dispose();
  } catch (err) {
    appendOutput(`Host error: ${err.message}`, 'error');
    statusEl.textContent = 'Execution failed';
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', run);

// Ctrl+Enter to run
codeEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
  }
});

init();
