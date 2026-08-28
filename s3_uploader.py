import os
from dotenv import load_dotenv
load_dotenv()
import boto3
from botocore.exceptions import ClientError
from botocore.config import Config
import logging

# Configure silent logging for boto3 and botocore
logging.getLogger('boto3').setLevel(logging.CRITICAL)
logging.getLogger('botocore').setLevel(logging.CRITICAL)
logging.getLogger('s3transfer').setLevel(logging.CRITICAL)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def _s3_config():
    """Build shared boto3 config: endpoint URL for R2 / S3-compatible storage."""
    endpoint = os.environ.get('S3_ENDPOINT_URL') or os.environ.get('AWS_ENDPOINT_URL')
    cfg = Config(signature_version='s3v4', retries={'max_attempts': 2})
    return endpoint, cfg


def _s3_client():
    """Return an authenticated S3-compatible client (Cloudflare R2, AWS S3, etc.)."""
    access_key = os.environ.get('AWS_ACCESS_KEY_ID')
    secret_key = os.environ.get('AWS_SECRET_ACCESS_KEY')
    endpoint, cfg = _s3_config()
    # 'auto' is valid for R2 but not for AWS S3 — default to a real region
    # when no custom endpoint is configured.
    default_region = 'auto' if endpoint else 'eu-west-3'
    region = os.environ.get('AWS_REGION', default_region)

    if not access_key or not secret_key:
        return None

    return boto3.client(
        's3',
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=cfg,
    )


def upload_file_to_s3(file_path, bucket_name, s3_key):
    """
    Upload a file to an S3-compatible bucket (R2, AWS S3, etc.).
    Returns True on success, False on failure or missing credentials.
    """
    s3_client = _s3_client()
    if s3_client is None:
        return False

    try:
        s3_client.upload_file(file_path, bucket_name, s3_key)
        return True
    except ClientError:
        return False
    except Exception:
        return False


def get_s3_client():
    """Returns an authenticated S3-compatible client (kept for backwards compat)."""
    return _s3_client()


def upload_job_artifacts(directory, job_id):
    """
    Upload all generated clips and metadata for a job to R2 / S3-compatible.
    Configure via env vars:
      S3_ENDPOINT_URL  — e.g. https://<accountid>.r2.cloudflarestorage.com
      AWS_ACCESS_KEY_ID       — R2 API token access key
      AWS_SECRET_ACCESS_KEY   — R2 API token secret
      AWS_REGION              — region (R2 uses 'auto')
      AWS_S3_BUCKET           — bucket name
    """
    bucket_name = os.environ.get('AWS_S3_BUCKET', 'openshorts-clips')

    if not os.path.exists(directory):
        return

    for filename in os.listdir(directory):
        # Upload .mp4 clips and the metadata JSON
        if (filename.endswith(".mp4") or filename.endswith(".json")) and not filename.startswith("temp_"):
            file_path = os.path.join(directory, filename)
            s3_key = f"{job_id}/{filename}"
            upload_file_to_s3(file_path, bucket_name, s3_key)


def delete_job_files(job_id, filenames):
    """
    Delete specific files of a job from the bucket (keys are "<job_id>/<name>",
    the same layout upload_job_artifacts writes).

    Returns (deleted, failed). Both are 0 when S3 is not configured — callers
    use that to tell "nothing to do" apart from "the backup is still there".
    """
    if not job_id or not filenames:
        return 0, 0
    s3_client = _s3_client()
    if s3_client is None:
        return 0, 0

    bucket_name = os.environ.get('AWS_S3_BUCKET', 'openshorts-clips')
    deleted = failed = 0
    for filename in filenames:
        try:
            s3_client.delete_object(Bucket=bucket_name, Key=f"{job_id}/{filename}")
            deleted += 1
        except Exception as e:
            print(f"⚠️  S3 delete failed for {job_id}/{filename}: {e}")
            failed += 1
    return deleted, failed


def upload_job_file(job_id, file_path):
    """
    Re-upload one file of a job, overwriting its backup copy. Used to keep the
    backup honest after a change on disk (e.g. a clip was deleted, so the
    project metadata no longer lists it).

    Returns True when it went up, False when S3 is not configured or the
    upload failed.
    """
    if not job_id or not file_path or not os.path.exists(file_path):
        return False
    bucket_name = os.environ.get('AWS_S3_BUCKET', 'openshorts-clips')
    return bool(upload_file_to_s3(file_path, bucket_name, f"{job_id}/{os.path.basename(file_path)}"))
