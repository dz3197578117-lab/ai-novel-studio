/**
 * 前端构建产物（内嵌进可执行文件）。
 *
 * 这里默认是空表：源码/开发模式下前端由 `apps/web/dist` 直接托管，
 * 不需要内嵌。打包 exe 时 `scripts/build-exe.mjs` 会临时把真实资源写进本文件，
 * 打完包再还原成空表——所以不要手改，也不要把它当数据源。
 */
export const WEB_ASSETS: Record<string, { type: string; base64: string }> = {};
