export const CONTAINER_R2_BUCKET_ENV = "SITE_BEHAVIOR_LAB_R2_BUCKET";

/**
 * Resolve the R2 bucket forwarded from the Containers Worker into Node.
 *
 * The Worker must never guess this deployment boundary: an absent binding in
 * a staging deployment previously selected the production reports bucket.
 */
export function requireContainerR2Bucket(value: string | undefined): string {
  const bucket = value?.trim();
  if (!bucket) {
    throw new Error(`${CONTAINER_R2_BUCKET_ENV} must name the deployment's R2 bucket.`);
  }
  return bucket;
}
