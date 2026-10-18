-- Filled-in copies of a contract.
--
-- An employee or contractor can download their contract, fill it in and send it
-- back as a PDF or Word file. The files go in the private HR bucket, beside the
-- contract, so the bucket has to accept Word files as well as PDFs and photos.
-- No table changes: the files are listed from storage and every upload, removal
-- and download is written to the audit log by the API.
begin;

update storage.buckets
set allowed_mime_types = array[
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]
where id = 'hr-documents';

commit;
