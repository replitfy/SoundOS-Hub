import app from "./app";
import { logger } from "./lib/logger";
import { syncUpcomingEventsKnowledge } from "./routes/sofia";
import { ensureSofiaPromptPadrao } from "./services/ensureSofiaPromptPadrao";
import { ensureSystemProfiles } from "./services/accessProfiles";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Os perfis de acesso do sistema vivem no código; publicar não leva dados ao banco de produção.
  void ensureSystemProfiles()
    .then(result => logger.info(result, "Perfis de acesso do sistema verificados"))
    .catch(profilesErr => logger.error({ err: profilesErr }, "Falha ao garantir os perfis de acesso do sistema"));

  // O prompt padrão vive no código; publicar não leva dados ao banco de produção.
  void ensureSofiaPromptPadrao()
    .then(result => logger.info(result, "Sofia: prompt padrão verificado"))
    .catch(promptErr => logger.error({ err: promptErr }, "Sofia: falha ao garantir o prompt padrão"));

  const syncEvents = () => {
    void syncUpcomingEventsKnowledge()
      .then(result => logger.info({
        events: result.updated.length,
        removed: result.removed,
        failures: result.failures.length,
        agendaCreated: result.agenda.events.filter(event => event.status === "created").length,
        agendaUpdated: result.agenda.events.filter(event => event.status === "updated").length,
        agendaArchived: result.agenda.archived,
        agendaArchivalSkipped: result.staleRemovalSkipped,
      }, "Soundfulness events synchronized"))
      .catch(syncErr => logger.warn({ err: syncErr }, "Soundfulness event sync failed; keeping previous knowledge"));
  };
  syncEvents();
  setInterval(syncEvents, 6 * 60 * 60 * 1000).unref();
});
