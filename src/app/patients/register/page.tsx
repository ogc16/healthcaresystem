import Image from "next/image";
import { redirect } from "next/navigation";

import RegisterForm from "@/components/forms/RegisterForm";
import { PatientLogoutButton } from "@/components/PatientLogoutButton";
import { getPatient, getUser } from "@/lib/actions/patient.actions";
import { requirePatient } from "@/lib/auth/guards";

const Register = async () => {
  await requirePatient();

  // Both reads are keyed on the session's userId, never on a URL param.
  const [patient, user] = await Promise.all([getPatient(), getUser()]);

  if (patient) redirect("/patients/new-appointment");

  if (!user) redirect("/login");

  return (
    <div className="flex h-screen max-h-screen">
      <section className="remove-scrollbar container">
        <div className="sub-container max-w-[860px] flex-1 flex-col py-10">
          <Image
            src="/assets/icons/logo-full.svg"
            height={1000}
            width={1000}
            alt="patient"
            className="mb-12 h-10 w-fit"
          />

          <RegisterForm user={user} />

          <div className="flex justify-end">
            <PatientLogoutButton />
          </div>

          <p className="copyright py-12">© 2026 CarePulse</p>
        </div>
      </section>

      <Image
        src="/assets/images/register-img.png"
        height={1000}
        width={1000}
        alt="patient"
        className="side-img max-w-[390px]"
      />
    </div>
  );
};

export default Register;
