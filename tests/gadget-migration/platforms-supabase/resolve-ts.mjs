// A module resolve hook: the app template's code imports local files without an extension
// ("./queue/pgmq-worker.server"), which Node's own TypeScript support doesn't resolve.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
}
