export {}
declare module 'orca' {
  interface PluginRequests {
    'osa.call': { input: { action: string; options?: Record<string, string>; stateDir?: string }; output: any }
  }
}
