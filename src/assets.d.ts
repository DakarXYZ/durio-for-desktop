/// <reference types="vite/client" />
// `?asset` imports are inlined by Vite as data URLs (see `nativeImage.createFromDataURL`)
declare module "*?asset" {
  const dataUrl: string;
  export default dataUrl;
}
