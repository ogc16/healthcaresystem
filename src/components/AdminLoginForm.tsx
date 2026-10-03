"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useTransition } from "react";

import { authenticateAdmin } from "@/app/admin/actions";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

export const AdminLoginForm = () => {
  const [passkey, setPasskey] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const formData = new FormData();

    formData.set("passkey", passkey);

    startTransition(async () => {
      const result = await authenticateAdmin(formData);

      if (result?.error) {
        setError(result.error);
        setPasskey("");
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <InputOTP
          maxLength={6}
          value={passkey}
          onChange={(value) => {
            setPasskey(value);
            setError("");
          }}
        >
          <InputOTPGroup className="shad-otp">
            {Array.from({ length: 6 }).map((_, index) => (
              <InputOTPSlot key={index} className="shad-otp-slot" index={index} />
            ))}
          </InputOTPGroup>
        </InputOTP>

        {error && (
          <p className="shad-error text-14-regular mt-4 flex justify-center">
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={isPending || passkey.length !== 6}
        className="shad-primary-btn w-full disabled:opacity-50"
      >
        {isPending ? "Verifying..." : "Enter Admin Passkey"}
      </button>

      <p className="text-14-regular flex items-center justify-center gap-2 text-dark-600">
        <Image src="/assets/icons/close.svg" alt="" width={14} height={14} />
        <Link href="/">Return to patient portal</Link>
      </p>
    </form>
  );
};