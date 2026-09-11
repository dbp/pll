declare module "*.whl" {
  /** Base64-encoded wheel bytes (esbuild `base64` loader). */
  const content: string;
  export default content;
}
