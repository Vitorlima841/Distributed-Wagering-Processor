/**
 * Leitura do `GET /metrics` (formato de texto do Prometheus) nos testes. Os valores são contagens e
 * segundos, nunca dinheiro.
 */
export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export class Scrape {
  constructor(readonly samples: readonly Sample[]) {}

  /** Soma das amostras com esse nome cujos labels incluem os dados (0 se nenhuma). */
  sum(name: string, labels: Record<string, string> = {}): number {
    return this.matching(name, labels).reduce((total, s) => total + s.value, 0);
  }

  /** Valor de uma amostra única (gauge sem label, por exemplo); undefined se não existir. */
  value(name: string, labels: Record<string, string> = {}): number | undefined {
    const found = this.matching(name, labels);
    if (found.length > 1) {
      throw new Error(`${name} tem ${found.length} amostras para ${JSON.stringify(labels)}`);
    }
    return found[0]?.value;
  }

  private matching(name: string, labels: Record<string, string>): Sample[] {
    return this.samples.filter(
      (s) =>
        s.name === name && Object.entries(labels).every(([key, value]) => s.labels[key] === value),
    );
  }
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parseMetrics(text: string): Scrape {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = SAMPLE.exec(line);
    if (!match) {
      throw new Error(`linha de métrica inválida: ${line}`);
    }
    const [, name = '', rawLabels = '', rawValue = ''] = match;
    const labels: Record<string, string> = {};
    for (const [, key = '', value = ''] of rawLabels.matchAll(LABEL)) {
      labels[key] = value.replace(/\\(.)/g, '$1');
    }
    samples.push({ name, labels, value: Number(rawValue) });
  }
  return new Scrape(samples);
}

export async function scrape(baseUrl: string): Promise<Scrape> {
  const res = await fetch(`${baseUrl}/metrics`);
  if (res.status !== 200) {
    throw new Error(`/metrics respondeu ${res.status}`);
  }
  return parseMetrics(await res.text());
}

/** Destino de log em memória (pino aceita qualquer objeto com `write`). */
export class LogCapture {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  // biome-ignore lint/suspicious/noExplicitAny: linha JSON livre nas asserções
  entries(): any[] {
    return this.lines.map((line) => JSON.parse(line));
  }
}
