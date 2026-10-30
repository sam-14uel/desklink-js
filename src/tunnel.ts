/**
 * Tunnel abstraction (ngrok + none).
 */
import ngrok from "ngrok";

export interface TunnelInfo {
  provider: string;
  public_url: string;
  local_url: string;
  tunnel_id?: string;
}

export interface TunnelProvider {
  start(localPort: number, authtoken?: string): Promise<TunnelInfo>;
  stop(): Promise<void>;
}

class NgrokTunnel implements TunnelProvider {
  private url: string | null = null;

  async start(localPort: number, authtoken?: string): Promise<TunnelInfo> {
    if (authtoken) {
      await ngrok.authtoken(authtoken);
    }
    this.url = await ngrok.connect({
      addr: localPort,
      proto: "http",
    });
    // Prefer https
    let publicUrl = this.url;
    if (publicUrl.startsWith("http://")) {
      publicUrl = "https://" + publicUrl.slice("http://".length);
    }
    return {
      provider: "ngrok",
      public_url: publicUrl,
      local_url: `http://127.0.0.1:${localPort}`,
    };
  }

  async stop(): Promise<void> {
    try {
      await ngrok.disconnect();
      await ngrok.kill();
    } catch {
      // ignore
    }
    this.url = null;
  }
}

class NoTunnel implements TunnelProvider {
  async start(localPort: number): Promise<TunnelInfo> {
    const local = `http://127.0.0.1:${localPort}`;
    return { provider: "none", public_url: local, local_url: local };
  }
  async stop(): Promise<void> {}
}

export function getTunnelProvider(name: string): TunnelProvider {
  const n = (name || "ngrok").toLowerCase();
  if (n === "ngrok") return new NgrokTunnel();
  if (n === "none" || n === "local" || n === "disabled") return new NoTunnel();
  throw new Error(`Unknown tunnel provider: ${name}`);
}
