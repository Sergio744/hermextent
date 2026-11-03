export type HostWebRequest = {
  id: string;
  type: 'web_request';
  providerId: string;
  model: string;
  request: {
    messages?: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>>;
    temperature?: number;
    max_tokens?: number;
    [key: string]: unknown;
  };
};

type Assembly = {
  providerId: string;
  model: string;
  totalBytes: number;
  chunks: Array<string | undefined>;
};

export type NativeAssemblyResult =
  | { kind: 'pending' }
  | { kind: 'request'; request: HostWebRequest }
  | { kind: 'error'; id: string; error: string }
  | null;

/** Reassembles provider requests split to stay below Chrome's 1 MiB host-to-extension frame limit. */
export class NativeWebRequestAssembler {
  private readonly assemblies = new Map<string, Assembly>();

  accept(message: Record<string, unknown>): NativeAssemblyResult {
    const id = typeof message.id === 'string' ? message.id : '';
    if (message.type === 'web_request_start') {
      const totalBytes = Number(message.totalBytes);
      const totalChunks = Number(message.totalChunks);
      if (!id || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > 4_000_000 || !Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 32 || typeof message.providerId !== 'string' || typeof message.model !== 'string') {
        this.assemblies.delete(id);
        return { kind: 'error', id, error: 'Requête Native Messaging segmentée invalide.' };
      }
      if (this.assemblies.has(id)) return { kind: 'error', id, error: 'Identifiant de requête Native Messaging dupliqué.' };
      this.assemblies.set(id, { providerId: message.providerId, model: message.model, totalBytes, chunks: new Array(totalChunks) });
      return { kind: 'pending' };
    }
    if (message.type === 'web_request_chunk') {
      const assembly = this.assemblies.get(id);
      const index = Number(message.index);
      if (!assembly || !Number.isSafeInteger(index) || index < 0 || index >= assembly.chunks.length || typeof message.data !== 'string' || message.data.length > 500_000 || assembly.chunks[index] !== undefined) {
        this.assemblies.delete(id);
        return { kind: 'error', id, error: 'Fragment Native Messaging invalide.' };
      }
      assembly.chunks[index] = message.data;
      return { kind: 'pending' };
    }
    if (message.type === 'web_request_end') {
      const assembly = this.assemblies.get(id);
      this.assemblies.delete(id);
      if (!assembly || assembly.chunks.some(chunk => typeof chunk !== 'string')) {
        return { kind: 'error', id, error: 'Requête Native Messaging incomplète.' };
      }
      try {
        const binaries = assembly.chunks.map(chunk => {
          const raw = atob(chunk!);
          return Uint8Array.from(raw, char => char.charCodeAt(0));
        });
        const actualBytes = binaries.reduce((total, part) => total + part.byteLength, 0);
        if (actualBytes !== assembly.totalBytes) throw new Error('taille invalide');
        const bytes = new Uint8Array(actualBytes);
        let offset = 0;
        for (const part of binaries) { bytes.set(part, offset); offset += part.byteLength; }
        const request = JSON.parse(new TextDecoder().decode(bytes)) as HostWebRequest;
        if (!request || request.id !== id || request.type !== 'web_request' || request.providerId !== assembly.providerId || request.model !== assembly.model || !request.request || typeof request.request !== 'object') {
          throw new Error('requête incohérente');
        }
        return { kind: 'request', request };
      } catch {
        return { kind: 'error', id, error: 'Impossible de reconstituer la requête fournisseur.' };
      }
    }
    return null;
  }

  clear() { this.assemblies.clear(); }
}
