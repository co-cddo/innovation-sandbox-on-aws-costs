import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface LeaseCostsStorageProps {
  /**
   * AWS account ID for bucket naming
   */
  readonly accountId: string;

  /**
   * AWS region for bucket naming
   */
  readonly region: string;

  /**
   * Custom bucket name (optional). If not provided, will use default naming pattern.
   */
  readonly bucketName?: string;

  /**
   * Lifecycle expiration in days
   * @default 1095 (3 years)
   */
  readonly expirationDays?: number;

  /**
   * S3 bucket removal policy
   * @default RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * L3 Construct for ISB Lease Costs Storage
 *
 * Creates an S3 bucket optimized for storing lease cost CSV files with:
 * - Server-side encryption
 * - Public access blocking
 * - Lifecycle rules for automatic expiration
 * - SSL enforcement
 *
 * @example
 * ```typescript
 * const storage = new LeaseCostsStorage(this, 'Storage', {
 *   accountId: this.account,
 *   region: this.region,
 *   expirationDays: 1095 // 3 years
 * });
 *
 * // Grant Lambda access
 * storage.bucket.grantReadWrite(myLambdaFunction);
 * ```
 */
export class LeaseCostsStorage extends Construct {
  /**
   * The S3 bucket for storing cost CSV files
   */
  public readonly bucket: s3.IBucket;

  /**
   * The name of the S3 bucket
   */
  public readonly bucketName: string;

  constructor(scope: Construct, id: string, props: LeaseCostsStorageProps) {
    super(scope, id);

    const bucketName =
      props.bucketName ?? `isb-lease-costs-${props.accountId}-${props.region}`;
    const expirationDays = props.expirationDays ?? 1095; // 3 years default
    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.RETAIN;

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(expirationDays),
        },
      ],
      removalPolicy,
    });

    this.bucketName = this.bucket.bucketName;

    // Output for easy reference
    new cdk.CfnOutput(this, "BucketName", {
      value: this.bucketName,
      description: "S3 bucket for cost CSV files",
    });
  }
}
