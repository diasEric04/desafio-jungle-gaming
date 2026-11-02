import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@/config/app-config';

export function createSqsClient(aws: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: aws.region,
    ...(aws.endpoint ? { endpoint: aws.endpoint } : {}),
    ...(aws.accessKeyId && aws.secretAccessKey
      ? { credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey } }
      : {}),
    maxAttempts: 3,
  });
}
