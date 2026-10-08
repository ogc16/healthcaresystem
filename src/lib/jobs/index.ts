// Handler registry entrypoint. Importing this module registers every job type
// the queue can drain; the cron route does exactly that before calling
// `drainJobs`. Handlers self-register at module scope, so adding a new job type
// is "write a handler file, list it here".
import "./invoice";
import "./reminder";