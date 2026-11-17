// One-off import of the "link_d_videos" spreadsheet (Documento 12) into the
// `videos` table. Safe to re-run: it clears prior rows first so it always
// reflects the seed data (spreadsheet re-import is out of scope per task #109).
import { db, pool, videosTable } from "@workspace/db";
import raw from "./data/videos-seed.json" with { type: "json" };

type RawVideo = {
  titulo: string | null;
  ref: string | null;
  tipo: string | null;
  curso: string | null;
  duracao: string | null;
  link: string | null;
};

function hasRealLink(link: string | null): boolean {
  return typeof link === "string" && (link.includes("youtube.com") || link.includes("youtu.be"));
}

async function main() {
  const rows = (raw as RawVideo[]).filter((r) => r.titulo);

  await db.transaction(async (tx) => {
    await tx.delete(videosTable);
    await tx.insert(videosTable).values(
      rows.map((r) => ({
        ref: r.ref,
        titulo: r.titulo!,
        tipo: r.tipo,
        curso: r.curso,
        duracao: r.duracao,
        link: r.link,
        temLinkReal: hasRealLink(r.link),
        aprovadoParaSofia: false,
      }))
    );
  });

  const total = rows.length;
  const withLink = rows.filter((r) => hasRealLink(r.link)).length;
  console.log(`Seed concluído: ${total} vídeos importados, ${withLink} com link real do YouTube.`);

  await pool.end();
}

main().catch((err) => {
  console.error("Falha ao popular tabela de vídeos:", err);
  process.exit(1);
});
