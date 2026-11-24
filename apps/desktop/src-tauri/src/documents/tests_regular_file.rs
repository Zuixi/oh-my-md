use super::*;

#[test]
fn document_reads_reject_non_regular_files() {
    let dir = tempfile::tempdir().unwrap();
    let dir_str = dir.path().to_str().unwrap();
    let error = read_document_blocking(dir_str).unwrap_err();
    assert!(matches!(error, DocumentError::ReadFailed(_)), "{error:?}");
    let stream_error = read_document_streaming_blocking(dir_str, 64, &|_| {}).unwrap_err();
    assert!(
        matches!(stream_error, DocumentError::ReadFailed(_)),
        "{stream_error:?}"
    );
    let cache = DocumentVersionCache::default();
    let version_error = read_document_version_cached(&cache, dir_str).unwrap_err();
    assert!(
        matches!(version_error, DocumentError::ReadFailed(_)),
        "{version_error:?}"
    );

    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        // Character devices (`/dev/zero` never terminates; `/dev/null` is non-regular)
        // must fail before any buffering starts.
        for device in ["/dev/null", "/dev/zero"] {
            let error = read_document_blocking(device).unwrap_err();
            assert!(matches!(error, DocumentError::ReadFailed(_)), "{error:?}");
            let stream_error = read_document_streaming_blocking(device, 64, &|_| {}).unwrap_err();
            assert!(
                matches!(stream_error, DocumentError::ReadFailed(_)),
                "{stream_error:?}"
            );
            let version_error = read_document_version_cached(&cache, device).unwrap_err();
            assert!(
                matches!(version_error, DocumentError::ReadFailed(_)),
                "{version_error:?}"
            );
        }

        // A writerless POSIX FIFO would deadlock forever in plain `File::open`.
        // `open_regular_file` uses `O_NONBLOCK` + `fstat`, so every read path
        // must reject it immediately without blocking.
        let fifo = dir.path().join("pipe.md");
        let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let fifo_str = fifo.to_str().unwrap();

        let error = read_document_blocking(fifo_str).unwrap_err();
        assert!(matches!(error, DocumentError::ReadFailed(_)), "{error:?}");
        let stream_error = read_document_streaming_blocking(fifo_str, 64, &|_| {}).unwrap_err();
        assert!(
            matches!(stream_error, DocumentError::ReadFailed(_)),
            "{stream_error:?}"
        );
        let version_error = read_document_version_cached(&cache, fifo_str).unwrap_err();
        assert!(
            matches!(version_error, DocumentError::ReadFailed(_)),
            "{version_error:?}"
        );
    }
}
