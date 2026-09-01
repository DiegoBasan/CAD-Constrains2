declare module "opencascade.js/dist/opencascade.wasm.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: (moduleOverrides?: Record<string, unknown>) => Promise<any>;
  export default factory;
}
