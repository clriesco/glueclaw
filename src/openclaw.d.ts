declare module "openclaw/plugin-sdk/plugin-entry" {
  /** Minimal session-end event payload — enough for our reset reaction. */
  export interface OpenClawSessionEndEvent {
    sessionId: string;
    sessionKey?: string;
    reason?: string;
    nextSessionId?: string;
    nextSessionKey?: string;
  }

  /** Minimal gateway RPC handler shape. The full payload is broader; we only
   *  type the fields we read. */
  export interface OpenClawGatewayMethodOpts {
    params?: Record<string, unknown>;
    respond: (
      ok: boolean,
      payload?: unknown,
      error?: { code?: string; message?: string },
    ) => void;
  }

  export type OpenClawGatewayMethodHandler = (
    opts: OpenClawGatewayMethodOpts,
  ) => void | Promise<void>;

  export interface OpenClawPluginApi {
    registerProvider(provider: unknown): void;
    /** Subscribe to a typed lifecycle hook. Optional — older openclaw runtimes
     *  may install a noop. */
    on?(
      hookName: "session_end",
      handler: (event: OpenClawSessionEndEvent) => void | Promise<void>,
    ): void;
    /** Register a gateway RPC method. Optional — older openclaw runtimes may
     *  install a noop. */
    registerGatewayMethod?(
      method: string,
      handler: OpenClawGatewayMethodHandler,
    ): void;
  }

  export function definePluginEntry(entry: {
    register(api: OpenClawPluginApi): void;
  }): unknown;
}
