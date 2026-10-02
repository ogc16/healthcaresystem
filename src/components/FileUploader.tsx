"use client";

import Image from "next/image";
import React, { useCallback, useState } from "react";
import { FileRejection, useDropzone } from "react-dropzone";

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_MEGABYTES,
} from "@/lib/uploads";
import { convertFileToUrl } from "@/lib/utils";

type FileUploaderProps = {
  files: File[] | undefined;
  onChange: (files: File[]) => void;
};

const describeRejection = (rejection: FileRejection) => {
  if (rejection.errors.some((error) => error.code === "file-too-large")) {
    return `That file is larger than the ${MAX_UPLOAD_MEGABYTES}MB limit.`;
  }

  return `Only ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")} files are accepted.`;
};

export const FileUploader = ({ files, onChange }: FileUploaderProps) => {
  const [error, setError] = useState("");

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      setError("");
      onChange(acceptedFiles);
    },
    [onChange]
  );

  const onDropRejected = useCallback((fileRejections: FileRejection[]) => {
    setError(describeRejection(fileRejections[0]));
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    accept: {
      "application/pdf": ALLOWED_UPLOAD_EXTENSIONS.filter((ext) => ext === ".pdf"),
      "image/jpeg": ALLOWED_UPLOAD_EXTENSIONS.filter((ext) =>
        [".jpg", ".jpeg"].includes(ext)
      ),
      "image/png": ALLOWED_UPLOAD_EXTENSIONS.filter((ext) => ext === ".png"),
    },
    maxSize: MAX_UPLOAD_MEGABYTES * 1024 * 1024,
    multiple: false,
  });

  return (
    <div {...getRootProps()} className="file-upload">
      <input {...getInputProps()} />
      {files && files?.length > 0 ? (
        <Image
          src={convertFileToUrl(files[0])}
          width={1000}
          height={1000}
          alt="uploaded document"
          className="max-h-[400px] overflow-hidden object-cover"
        />
      ) : (
        <>
          <Image
            src="/assets/icons/upload.svg"
            width={40}
            height={40}
            alt="upload"
          />
          <div className="file-upload_label">
            <p className="text-14-regular ">
              <span className="text-green-500">Click to upload </span>
              or drag and drop
            </p>
            <p className="text-12-regular">
              {ALLOWED_UPLOAD_EXTENSIONS.join(", ").toUpperCase()} (max{" "}
              {MAX_UPLOAD_MEGABYTES}MB)
            </p>
          </div>
        </>
      )}

      {error ? (
        <p className="shad-error text-12-regular mt-2">{error}</p>
      ) : isDragActive ? (
        <p className="text-12-regular mt-2 text-green-500">Drop the file here</p>
      ) : null}
    </div>
  );
};