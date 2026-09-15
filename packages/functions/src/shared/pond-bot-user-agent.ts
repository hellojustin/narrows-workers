/**
 * User agent Pond's servers send when they fetch a publisher's feed or
 * enclosure. Distinct from the listener token (`Pond/`) so a classifier can
 * tell ingest traffic from a countable download with a regex.
 *
 * IAB v2.2 §7.2: a bot's user agent "should be specified in a way that is
 * distinct from the application user-agent and should also include the word
 * 'bot'". `PondBot/` satisfies both. The reference is pondaudio.app, the
 * production domain.
 */
export const POND_BOT_USER_AGENT = "PondBot/1.0 (+https://pondaudio.app)";
