import { Models } from "node-appwrite";
import { describe, expect, it, vi } from "vitest";


import {
  PATIENT_BATCH_SIZE,
  PatientListFn,
  attachPatientSummaries,
  batchFetchPatientSummaries,
  chunkIds,
  uniquePatientIds,
} from "./patient-batch";

const document = (
  $id: string,
  overrides: Record<string, unknown> = {}
): Models.Document =>
  ({
    $id,
    name: "",
    $createdAt: "",
    $updatedAt: "",
    ...overrides,
  }) as unknown as Models.Document;

describe("uniquePatientIds", () => {
  it("collects distinct string refs in first-seen order", () => {
    expect(
      uniquePatientIds([
        { patient: "p-1" },
        { patient: "p-2" },
        { patient: "p-1" },
        {},
        { patient: "p-3" },
      ])
    ).toEqual(["p-1", "p-2", "p-3"]);
  });

  it("skips empty strings and non-string refs", () => {
    expect(
      uniquePatientIds([
        { patient: "" },
        { patient: 123 },
        { patient: { $id: "nested" } },
      ])
    ).toEqual([]);
  });
});

describe("chunkIds", () => {
  it("splits into chunks no larger than the given size", () => {
    const ids = Array.from({ length: 250 }, (_, index) => `p-${index}`);

    const chunks = chunkIds(ids);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(PATIENT_BATCH_SIZE);
    expect(chunks[1]).toHaveLength(PATIENT_BATCH_SIZE);
    expect(chunks[2]).toHaveLength(50);
  });

  it("returns a single chunk when ids fit", () => {
    expect(chunkIds(["a", "b"])).toEqual([["a", "b"]]);
  });

  it("returns no chunks for an empty input", () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe("batchFetchPatientSummaries", () => {
  const list = (documents: Models.Document[]) =>
    vi.fn(async () => ({ documents })) as unknown as PatientListFn;

  it("issues one query per chunk of ids, with equal, select, and limit", async () => {
    const documents = [document("p-1", { name: "Ada" })];
    const listDocuments = list(documents);

    const lookup = await batchFetchPatientSummaries(["p-1"], listDocuments);

    expect(listDocuments).toHaveBeenCalledOnce();
    const queries = (listDocuments as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string[];

    expect(queries.map((query) => JSON.parse(query))).toEqual([
      { method: "equal", attribute: "$id", values: ["p-1"] },
      { method: "select", values: ["name"] },
      { method: "limit", values: [1] },
    ]);

    expect(lookup.get("p-1")).toEqual({ $id: "p-1", name: "Ada" });
  });

  it("issues PATIENT_BATCH_SIZE queries total across many ids", async () => {
    const listDocuments = vi.fn(async () => ({ documents: [] })) as unknown as PatientListFn;

    await batchFetchPatientSummaries(
      Array.from({ length: 250 }, (_, index) => `p-${index}`),
      listDocuments
    );

    expect(listDocuments).toHaveBeenCalledTimes(3);
  });

  it("deduplicates input ids so repeats never cost extra queries", async () => {
    const listDocuments = vi.fn(async () => ({ documents: [] })) as unknown as PatientListFn;

    await batchFetchPatientSummaries(
      Array.from({ length: 105 }, () => "p-same"),
      listDocuments
    );

    expect(listDocuments).toHaveBeenCalledOnce();
  });

  it("skips documents that did not carry a string name", async () => {
    const listDocuments = list([
      document("p-1", { name: "Ada" }),
      document("p-2", { name: null }),
    ]);

    const lookup = await batchFetchPatientSummaries(
      ["p-1", "p-2"],
      listDocuments
    );

    expect(lookup.get("p-1")).toEqual({ $id: "p-1", name: "Ada" });
    expect(lookup.has("p-2")).toBe(false);
  });
});

describe("attachPatientSummaries", () => {
  it("hydrates each row through the lookup map without re-scanning the list", () => {
    const lookup = new Map([
      ["p-1", { $id: "p-1", name: "Ada" }],
      ["p-2", { $id: "p-2", name: "Grace" }],
    ]);

    expect(
      attachPatientSummaries([{ patient: "p-1" }, { patient: "p-2" }], lookup)
    ).toEqual([
      { patient: { $id: "p-1", name: "Ada" } },
      { patient: { $id: "p-2", name: "Grace" } },
    ]);
  });

  it("leaves already-expanded and unresolved rows untouched", () => {
    const lookup = new Map([["p-1", { $id: "p-1", name: "Ada" }]]);

    const rows = [
      { patient: "p-1" },
      { patient: "p-missing" },
      { patient: { $id: "nested", name: "Already" } },
    ] as { patient: unknown }[];

    const result = attachPatientSummaries(rows, lookup);

    expect(result[0]).toEqual({ patient: { $id: "p-1", name: "Ada" } });
    expect(result[1]).toEqual({ patient: "p-missing" });
    expect(result[2]).toEqual({ patient: { $id: "nested", name: "Already" } });
  });
});