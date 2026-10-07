// In-memory mock of the Appwrite REST surface that CarePulse uses, so the
// Playwright suite exercises the real server actions against a deterministic
// backend instead of a real project the tests cannot create.
//
// The app talks to this through node-appwrite v29, so the routes mirror that
// SDK's request shapes (paths, JSON bodies, `queries[]` params).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";

const PORT = 7800;

const PATIENTS_COLLECTION = "test-patients";
const APPOINTMENTS_COLLECTION = "test-appointments";

const state = {
  users: new Map(), // id -> user record (password kept separately)
  usersByEmail: new Map(),
  passwords: new Map(), // userId -> password
  sessions: new Map(), // sid -> { userId }
  documents: new Map(), // `${db}/${coll}/${id}` -> doc
  messages: [],
  seq: 0,
};

const nowIso = () => new Date().toISOString();

const randomId = (prefix) =>
  `${prefix}-${++state.seq}-${randomBytes(4).toString("hex")}`;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const appwriteError = (status, type, message) => {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  return error;
};

const documentKey = (databaseId, collectionId, id) =>
  `${databaseId}/${collectionId}/${id}`;

const storeDocument = (databaseId, collectionId, id, data) => {
  const timestamp = nowIso();
  const doc = {
    $id: id,
    $databaseId: databaseId,
    $collectionId: collectionId,
    $createdAt: timestamp,
    $updatedAt: timestamp,
    $permissions: [],
    ...data,
  };

  state.documents.set(documentKey(databaseId, collectionId, id), doc);

  return doc;
};

const findPatient = (collectionId, patientRef) => {
  if (patientRef && typeof patientRef === "object") return patientRef;

  const id = typeof patientRef === "string" ? patientRef : null;
  if (!id) return null;

  const patient = state.documents.get(
    documentKey("test-database", PATIENTS_COLLECTION, id)
  );

  return patient ? { ...patient } : null;
};

// Appwrite expands relationship attributes (like `patient`) into the related
// document's attributes, so the dashboard's `appointment.patient.name` and the
// modal's `appointment.patient.$id` both resolve.
const withPatientExpanded = (collectionId, appointment) => {
  if (!appointment || (typeof appointment.patient !== "string")) {
    return appointment;
  }

  const patient = findPatient(collectionId, appointment.patient);

  if (!patient) return appointment;

  return { ...appointment, patient };
};

// --- Query parsing (the forms this app emits) -------------------------------

const splitArgs = (input) => {
  const parts = [];
  let current = "";
  let inQuotes = false;

  for (const char of input) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === "," && !inQuotes) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  parts.push(current.trim());

  return parts;
};

const parseArg = (arg) => {
  const trimmed = arg.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
};

const parseQuery = (value) => {
  const match = /^([a-zA-Z]+)\((.*)\)$/.exec(value.trim());
  if (!match) return null;

  return {
    name: match[1],
    args: splitArgs(match[2]).map(parseArg),
  };
};

const filterByQuery = (docs, queries) => {
  let result = [...docs];

  for (const query of queries) {
    const [attribute, ...rest] = query.args;

    switch (query.name) {
      case "equal":
      case "equals": {
        const allowed = new Set(
          Array.isArray(rest[0]) ? rest[0] : [rest[0]]
        );
        result = result.filter(
          (doc) => doc[attribute] !== undefined && allowed.has(doc[attribute])
        );
        break;
      }
      case "notEqual": {
        result = result.filter((doc) => doc[attribute] !== rest[0]);
        break;
      }
      case "between": {
        const [min, max] = rest;
        const minMs = new Date(min).getTime();
        const maxMs = new Date(max).getTime();
        result = result.filter((doc) => {
          const value = new Date(doc[attribute]).getTime();
          return value >= minMs && value <= maxMs;
        });
        break;
      }
      case "orderDesc": {
        result = [...result].sort(
          (a, b) =>
            new Date(b[attribute]).getTime() - new Date(a[attribute]).getTime()
        );
        break;
      }
      case "orderAsc": {
        result = [...result].sort(
          (a, b) =>
            new Date(a[attribute]).getTime() - new Date(b[attribute]).getTime()
        );
        break;
      }
      case "limit":
        result = result.slice(0, Number(query.args[0]));
        break;
      case "offset":
        result = result.slice(Number(query.args[0]));
        break;
      default:
        break;
    }
  }

  return result;
};

// --- Route handlers ---------------------------------------------------------

const createUser = async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString() || "{}");
  const email = String(body.email ?? "").toLowerCase();

  if (state.usersByEmail.has(email)) {
    throw appwriteError(409, "user_email_exists", "User already registered");
  }

  const userId = String(body.userId ?? randomId("user"));
  const user = {
    $id: userId,
    userId,
    name: String(body.name ?? ""),
    email: String(body.email ?? ""),
    phone: String(body.phone ?? ""),
    labels: [],
    prefs: {},
  };

  state.users.set(userId, user);
  state.usersByEmail.set(email, userId);
  state.passwords.set(userId, String(body.password ?? ""));

  return user;
};

const createEmailSession = async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString() || "{}");
  const email = String(body.email ?? "").toLowerCase();
  const userId = state.usersByEmail.get(email);
  const user = userId ? state.users.get(userId) : null;

  if (!user || state.passwords.get(userId) !== String(body.password ?? "")) {
    throw appwriteError(401, "user_invalid_credentials", "Invalid credentials");
  }

  const sessionId = randomId("session");
  state.sessions.set(sessionId, { userId });

  return { $id: sessionId, userId, expire: nowIso() };
};

const getUserById = (userId) => {
  const user = state.users.get(userId);
  if (!user) {
    throw appwriteError(404, "user_not_found", "User not found");
  }
  return user;
};

const deleteSession = async (req, res, segments) => {
  const [, , , , sessionId] = segments;
  state.sessions.delete(sessionId);
  return {};
};

const listDocuments = (req, res, segments) => {
  const [, , databaseId, , collectionId] = segments;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawQueries = [
    ...url.searchParams.getAll("queries"),
    ...url.searchParams.getAll("queries[]"),
  ]
    .filter(Boolean)
    .map(parseQuery)
    .filter(Boolean);

  const all = [...state.documents.entries()]
    .filter(([key]) => key.startsWith(`${databaseId}/${collectionId}/`))
    .map(([, doc]) => doc);

  const documents = filterByQuery(all, rawQueries).map((doc) =>
    withPatientExpanded(collectionId, doc)
  );

  return { total: documents.length, documents };
};

const getDocument = (req, res, segments) => {
  const [, , databaseId, , collectionId, , documentId] = segments;
  const doc = state.documents.get(documentKey(databaseId, collectionId, documentId));

  if (!doc) {
    throw appwriteError(404, "document_not_found", "Document not found");
  }

  return withPatientExpanded(collectionId, doc);
};

const createDocument = async (req, res, segments) => {
  const [, , databaseId, , collectionId] = segments;
  const raw = (await readBody(req)).toString();
  const body = raw ? JSON.parse(raw) : {};

  // The SDK's `documentId` lands either in the body or directly in the path;
  // the document data sits at the top level or under a `data` key.
  const documentId = String(body.documentId ?? randomId("doc"));
  const data = body.data ?? body;
  const stored = { ...data };
  delete stored.documentId;
  delete stored.data;

  return storeDocument(databaseId, collectionId, documentId, stored);
};

const updateDocument = async (req, res, segments) => {
  const [, , databaseId, , collectionId, , documentId] = segments;
  const key = documentKey(databaseId, collectionId, documentId);
  const existing = state.documents.get(key);

  if (!existing) {
    throw appwriteError(404, "document_not_found", "Document not found");
  }

  const raw = (await readBody(req)).toString();
  const body = raw ? JSON.parse(raw) : {};
  const merged = { ...existing, ...(body.data ?? body), $updatedAt: nowIso() };

  state.documents.set(key, merged);

  return merged;
};

const createFile = async (req, res, segments) => {
  // This app only ever inspects `$id` from a created file; the payload does
  // not need to be parsed or stored for that contract to hold.
  await readBody(req);

  const bucketId = segments[3];

  return {
    $id: randomId("file"),
    bucketId,
    name: "document.png",
    mimeType: "image/png",
    sizeOriginal: 1,
    signature: randomBytes(16).toString("hex"),
    $createdAt: nowIso(),
    $updatedAt: nowIso(),
  };
};

const createSms = async (req, res, segments) => {
  const raw = (await readBody(req)).toString();
  const body = raw ? JSON.parse(raw) : {};
  const message = {
    $id: randomId("message"),
    message: String(body.content ?? ""),
    users: body.users ?? [],
    topics: body.topics ?? [],
    targets: body.targets ?? [],
  };

  state.messages.push(message);

  return message;
};

const seed = async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString() || "{}");

  let userId;
  let patientId;

  if (body.user) {
    const user = body.user;
    userId = String(user.id ?? user.$id ?? randomId("user"));
    const email = String(user.email ?? "").toLowerCase();

    const record = {
      $id: userId,
      userId,
      name: String(user.name ?? ""),
      email: String(user.email ?? ""),
      phone: String(user.phone ?? ""),
      labels: [],
      prefs: {},
    };

    state.users.set(userId, record);
    state.usersByEmail.set(email, userId);
    state.passwords.set(userId, String(user.password ?? ""));
  }

  if (body.patient) {
    patientId = randomId("patient");
    storeDocument("test-database", PATIENTS_COLLECTION, patientId, {
      ...body.patient,
      userId,
    });
  }

  if (body.appointment) {
    storeDocument(
      "test-database",
      APPOINTMENTS_COLLECTION,
      randomId("appointment"),
      {
        status: "pending",
        ...body.appointment,
        userId,
        patient: body.appointment.patient ?? patientId,
      }
    );
  }

  return { ok: true, userId, patientId };
};

const reset = () => {
  state.users.clear();
  state.usersByEmail.clear();
  state.passwords.clear();
  state.sessions.clear();
  state.documents.clear();
  state.messages = [];
  state.seq = 0;

  return { ok: true };
};

// --- Server ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    let result;

    if (path === "/v1/__health" && method === "GET") {
      result = { ok: true };
    } else if (path === "/v1/__reset" && method === "POST") {
      result = reset();
    } else if (path === "/v1/__seed" && method === "POST") {
      result = await seed(req, res);
    } else if (path === "/v1/__messages" && method === "GET") {
      result = { messages: state.messages };
    } else {
      const segments = path.split("/").filter(Boolean);

      if (method === "POST" && segments.join("/") === "v1/users") {
        result = await createUser(req, res);
      } else if (
        method === "POST" &&
        segments.join("/") === "v1/account/sessions/email"
      ) {
        result = await createEmailSession(req, res);
      } else if (
        method === "GET" &&
        segments.length === 3 &&
        segments[0] === "v1" &&
        segments[1] === "users"
      ) {
        result = getUserById(segments[2]);
      } else if (
        method === "DELETE" &&
        segments.length === 5 &&
        segments[0] === "v1" &&
        segments[1] === "users" &&
        segments[3] === "sessions"
      ) {
        result = deleteSession(req, res, segments);
      } else if (
        method === "GET" &&
        segments.length === 6 &&
        segments[0] === "v1" &&
        segments[1] === "databases"
      ) {
        result = listDocuments(req, res, segments);
      } else if (
        method === "POST" &&
        segments.length === 6 &&
        segments[0] === "v1" &&
        segments[1] === "databases"
      ) {
        result = await createDocument(req, res, segments);
      } else if (
        method === "GET" &&
        segments.length === 7 &&
        segments[0] === "v1" &&
        segments[1] === "databases"
      ) {
        result = getDocument(req, res, segments);
      } else if (
        method === "PATCH" &&
        segments.length === 7 &&
        segments[0] === "v1" &&
        segments[1] === "databases"
      ) {
        result = await updateDocument(req, res, segments);
      } else if (
        method === "POST" &&
        segments.length === 5 &&
        segments[0] === "v1" &&
        segments[1] === "storage" &&
        segments[2] === "buckets"
      ) {
        result = await createFile(req, res, segments);
      } else if (
        method === "POST" &&
        segments.join("/") === "v1/messaging/messages" ||
        segments.join("/") === "v1/messaging/messages/sms"
      ) {
        result = await createSms(req, res, segments);
      } else {
        throw appwriteError(404, "route_not_found", "No such route");
      }
    }

    reply(res, 200, result);
  } catch (error) {
    const status = error.status ?? 500;
    const type = error.type ?? "internal_error";
    const message = error instanceof Error ? error.message : String(error);

    reply(res, status, { message, type, code: status, version: "mock" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock appwrite listening on http://localhost:${PORT}/v1`);
});