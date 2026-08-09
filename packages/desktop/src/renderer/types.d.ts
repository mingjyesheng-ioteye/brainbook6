declare module '*.svg' {
  const content: string;
  export default content;
}

declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '*.png' {
  const content: string;
  export default content;
}

declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'unocss';

declare const __APP_VERSION__: string;
declare const __AIONUI_PARENT_REVISION__: string;
declare const __AIONCORE_PARENT_REVISION__: string;
