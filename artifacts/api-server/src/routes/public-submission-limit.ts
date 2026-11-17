// Limite de envios dos formulários públicos: 20 por minuto por visitante e formulário.
const submissionBuckets = new Map<string, { count: number; resetAt: number }>();

export function allowSubmission(ip: string, slug: string): boolean {
  const key = `${ip}:${slug}`, now = Date.now();
  if (submissionBuckets.size > 10000) for (const [k, v] of submissionBuckets) if (v.resetAt <= now) submissionBuckets.delete(k);
  const current = submissionBuckets.get(key);
  if (!current || current.resetAt <= now) { submissionBuckets.set(key, { count: 1, resetAt: now + 60_000 }); return true; }
  if (current.count >= 20) return false;
  current.count++;
  return true;
}
