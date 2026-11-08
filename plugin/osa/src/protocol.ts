export {}
declare module 'orca' {
  interface PluginRequests {
    'osa.open-workbench': { input: Record<string, never>; output: { opened: boolean; file: string } }
    'osa.call': { input: { action: string; options?: Record<string, string>; stateDir?: string }; output: any }
  }
}
