import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/forms/LoginForm";
import { isPatientSession } from "@/lib/auth/guards";
import { safeReturnPath } from "@/lib/auth/return-path";

const Login = async ({
  searchParams,
}: {
  searchParams?: { from?: string | string[] };
}) => {
  if (await isPatientSession()) redirect(safeReturnPath(searchParams?.from));

  const returnTo = safeReturnPath(searchParams?.from);

  return (
    <div className="flex h-screen max-h-screen">
      <section className="remove-scrollbar container my-auto">
        <div className="sub-container max-w-[860px] flex-1 justify-between">
          <Image
            src="/assets/icons/logo-full.svg"
            height={1000}
            width={1000}
            alt="logo"
            className="mb-12 h-10 w-fit"
          />

          <LoginForm returnTo={returnTo} />

          <p className="text-center text-sm text-dark-700">
            Need an account?{" "}
            <Link href="/" className="text-green-500 underline">
              Get started
            </Link>
          </p>

          <p className="copyright mt-10 py-12">© 2024 CarePluse</p>
        </div>
      </section>

      <Image
        src="/assets/images/onboarding-img.png"
        height={1500}
        width={1500}
        alt="login"
        className="side-img max-w-[390px] bg-bottom"
      />
    </div>
  );
};

export default Login;
