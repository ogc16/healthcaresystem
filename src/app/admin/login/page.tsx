import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminLoginForm } from "@/components/AdminLoginForm";
import { isAdminSession } from "@/lib/auth/guards";

const AdminLoginPage = async () => {
  if (await isAdminSession()) redirect("/admin");

  return (
    <div className="flex h-screen max-h-screen">
      <section className="remove-scrollbar container my-auto">
        <div className="sub-container max-w-[496px]">
          <Link href="/" className="mb-12 block w-fit">
            <Image
              src="/assets/icons/logo-full.svg"
              height={32}
              width={162}
              alt="logo"
              className="h-8 w-fit"
            />
          </Link>

          <h1 className="header">Admin Access</h1>
          <p className="text-14-regular mb-8 text-dark-600">
            Enter your admin passkey to continue.
          </p>

          <AdminLoginForm />
        </div>
      </section>

      <Image
        src="/assets/images/onboarding-img.png"
        height={1000}
        width={1000}
        alt="patient"
        className="side-img max-w-[50%]"
      />
    </div>
  );
};

export default AdminLoginPage;