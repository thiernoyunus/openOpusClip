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

