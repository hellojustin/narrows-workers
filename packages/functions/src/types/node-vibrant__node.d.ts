// node-vibrant@3.2.1-alpha.1 does not ship types for its /node entry point.
// This ambient declaration re-exports the typed main package so the Node.js
// bundle import works with TypeScript.
declare module "node-vibrant/node" {
  export { default as Vibrant } from "node-vibrant";
}
