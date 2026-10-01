// Family notifications: Amazon SNS when configured (SMS/email fan-out), always logged locally.

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { Caregiver, Severity } from "./domain.js";

export interface Notification {
  severity: Severity;
  subject: string;
  body: string;
  to: Caregiver[];
}

export interface Notifier {
  send(n: Notification): Promise<void>;
  recent(): (Notification & { sentAt: string; channel: string })[];
}

export class FamilyNotifier implements Notifier {
  private log: (Notification & { sentAt: string; channel: string })[] = [];
  private sns?: SNSClient;
  constructor(private topicArn = process.env.SNS_TOPIC_ARN) {
    if (topicArn) this.sns = new SNSClient({ region: process.env.AWS_REGION });
  }

  async send(n: Notification) {
    let channel = "console";
    if (this.sns && this.topicArn) {
      try {
        await this.sns.send(
          new PublishCommand({
            TopicArn: this.topicArn,
            Subject: n.subject.slice(0, 99),
            Message: `${n.body}\n\n— CareCircle`,
            MessageAttributes: { severity: { DataType: "String", StringValue: n.severity } },
          }),
        );
        channel = "sns";
      } catch (e) {
        console.error("[notify] SNS publish failed:", (e as Error).message);
      }
    }
    const entry = { ...n, sentAt: new Date().toISOString(), channel };
    this.log.unshift(entry);
    this.log = this.log.slice(0, 50);
    console.log(`[notify:${channel}] (${n.severity}) ${n.subject} → ${n.to.map((c) => c.name).join(", ") || "family"}: ${n.body}`);
  }

  recent() {
    return this.log;
  }
}
