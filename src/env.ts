// App version re-export so the dsh layer can import it as a value.
// `__APP_VERSION__` is a Vite define global (declared in vite-env.d.ts).

export const APP_VERSION: string = __APP_VERSION__
