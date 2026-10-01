// Storage: a tiny single-table key/value abstraction.
// MemoryStore for local dev/tests, DynamoStore for AWS (pk = kind, sk = id).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

export type Kind =
  | "member"
  | "caregiver"
  | "medication"
  | "dose"
  | "checkin"
  | "message"
  | "alert"
  | "appointment"
  | "settings";

export interface Store {
  get<T>(kind: Kind, id: string): Promise<T | undefined>;
  list<T>(kind: Kind): Promise<T[]>;
  put<T extends { id: string }>(kind: Kind, item: T): Promise<void>;
  delete(kind: Kind, id: string): Promise<void>;
}

export class MemoryStore implements Store {
  private data = new Map<Kind, Map<string, unknown>>();

  private bucket(kind: Kind) {
    let b = this.data.get(kind);
    if (!b) this.data.set(kind, (b = new Map()));
    return b;
  }
  async get<T>(kind: Kind, id: string) {
    const v = this.bucket(kind).get(id);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async list<T>(kind: Kind) {
    return [...this.bucket(kind).values()].map((v) => structuredClone(v) as T);
  }
  async put<T extends { id: string }>(kind: Kind, item: T) {
    this.bucket(kind).set(item.id, structuredClone(item));
  }
  async delete(kind: Kind, id: string) {
    this.bucket(kind).delete(id);
  }
}

export class DynamoStore implements Store {
  private doc: DynamoDBDocumentClient;
  constructor(private table: string, region?: string) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  async get<T>(kind: Kind, id: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: kind, sk: id } }));
    return r.Item ? (strip(r.Item) as T) : undefined;
  }
  async list<T>(kind: Kind) {
    const out: T[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": kind },
          ExclusiveStartKey: start,
        }),
      );
      for (const i of r.Items ?? []) out.push(strip(i) as T);
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }
  async put<T extends { id: string }>(kind: Kind, item: T) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: kind, sk: item.id, ...item } }));
  }
  async delete(kind: Kind, id: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: kind, sk: id } }));
  }
}

function strip(item: Record<string, unknown>) {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
}

export function createStore(): Store {
  const table = process.env.CARECIRCLE_TABLE;
  return table ? new DynamoStore(table, process.env.AWS_REGION) : new MemoryStore();
}
