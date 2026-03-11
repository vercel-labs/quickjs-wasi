/*
 * QuickJS Extension: queueMicrotask
 *
 * WHATWG HTML Standard compliant implementation of queueMicrotask().
 * Uses QuickJS's JS_EnqueueJob to schedule callbacks on the microtask queue.
 *
 * References:
 *   - https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#microtask-queuing
 */

#include "quickjs.h"

/* Job function called by QuickJS job queue.
   argv[0] = the user callback function */
static JSValue microtask_job(JSContext *ctx, int argc, JSValueConst *argv) {
    JSValue callback = argv[0];
    JSValue ret = JS_Call(ctx, callback, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(ret)) {
        /* Per spec, exceptions from the callback are "reported"
           (not suppressed). In QuickJS, returning the exception
           from the job function will cause it to be reported by
           the host when it calls JS_ExecutePendingJob. */
        return ret;
    }
    JS_FreeValue(ctx, ret);
    return JS_UNDEFINED;
}

static JSValue js_queue_microtask(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "queueMicrotask requires a function argument");
    }

    /* Enqueue the callback as a job. JS_EnqueueJob will dup the argv values. */
    int ret = JS_EnqueueJob(ctx, microtask_job, 1, argv);
    if (ret < 0) {
        return JS_EXCEPTION;
    }

    return JS_UNDEFINED;
}

/* ---- Extension entry point ---- */

__attribute__((visibility("default")))
int qjs_ext_queue_microtask_init(JSContext *ctx, JSRuntime *rt) {
    JSValue global = JS_GetGlobalObject(ctx);

    JS_SetPropertyStr(ctx, global, "queueMicrotask",
        JS_NewCFunction(ctx, js_queue_microtask, "queueMicrotask", 1));

    JS_FreeValue(ctx, global);
    return 0;
}
