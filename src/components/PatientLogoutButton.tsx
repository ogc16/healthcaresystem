"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { logoutPatient } from "@/lib/actions/auth.actions";

/**
 * Patient sign-out. `logoutPatient` revokes the upstream Appwrite session and
 * clears the cookie, so the button is the only sanctioned way out — navigating
 * away would leave a valid session behind.
 */
export const PatientLogoutButton = ({ className }: { className?: string }) => {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const onClick = async () => {
    setIsLoading(true);

    try {
      await logoutPatient();
      router.refresh();
      router.push("/login");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      className={className}
      onClick={onClick}
      disabled={isLoading}
    >
      {isLoading ? "Signing out…" : "Sign out"}
    </Button>
  );
};
