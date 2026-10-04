import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { StatCard } from "@/components/StatCard";
import { columns } from "@/components/table/columns";
import { DataTable } from "@/components/table/DataTable";
import {
  getRecentAppointmentList,
  type RecentAppointments,
} from "@/lib/actions/appointment.actions";
import { isAdminSession } from "@/lib/auth/guards";

import { signOutAdmin } from "./actions";

type DataSourceProblem = Exclude<RecentAppointments, { status: "ok" }>;

/**
 * Stands in for the statistics and the table when there is nothing to count.
 *
 * Deliberately not the numbers. Rendering zeroes for an unreachable database
 * tells an admin that no patients have booked, which is the one conclusion this
 * screen exists to rule in or out, and a wrong one at that is how a booking
 * outage goes unnoticed.
 */
const DataSourceProblemNotice = ({ problem }: { problem: DataSourceProblem }) => {
  if (problem.status === "unconfigured") {
    return (
      <section className="w-full space-y-3">
        <h2 className="header">Appwrite is not configured</h2>
        <p className="text-14-regular text-dark-700">
          This dashboard reads appointments from Appwrite, and this server has
          not been given the credentials it needs. No counts are shown, because
          an empty database and a misconfigured server are not the same thing
          and should not look alike.
        </p>
        <p className="shad-error text-14-regular">
          Set these in .env.local, then restart the server:{" "}
          {problem.missing.join(", ")}
        </p>
      </section>
    );
  }

  return (
    <section className="w-full space-y-3">
      <h2 className="header">Could not reach Appwrite</h2>
      <p className="text-14-regular text-dark-700">
        Configuration looks complete, but the appointment query failed, so the
        counts below would be guesses. The underlying error is in the server
        log.
      </p>
    </section>
  );
};

const AdminPage = async () => {
  if (!(await isAdminSession())) redirect("/admin/login");

  const appointments = await getRecentAppointmentList();

  return (
    <div className="mx-auto flex max-w-7xl flex-col space-y-14">
      <header className="admin-header">
        <Link href="/" className="cursor-pointer">
          <Image
            src="/assets/icons/logo-full.svg"
            height={32}
            width={162}
            alt="logo"
            className="h-8 w-fit"
          />
        </Link>

        <p className="text-16-semibold">Admin Dashboard</p>

        <form action={signOutAdmin}>
          <button type="submit" className="text-14-regular text-green-500">
            Sign out
          </button>
        </form>
      </header>

      <main className="admin-main">
        {appointments.status === "ok" ? (
          <>
            <section className="w-full space-y-4">
              <h1 className="header">Welcome 👋</h1>
              <p className="text-dark-700">
                Start the day with managing new appointments
              </p>
            </section>

            <section className="admin-stat">
              <StatCard
                type="appointments"
                count={appointments.data.scheduledCount}
                label="Scheduled appointments"
                icon="/assets/icons/appointments.svg"
              />
              <StatCard
                type="pending"
                count={appointments.data.pendingCount}
                label="Pending appointments"
                icon="/assets/icons/pending.svg"
              />
              <StatCard
                type="cancelled"
                count={appointments.data.cancelledCount}
                label="Cancelled appointments"
                icon="/assets/icons/cancelled.svg"
              />
            </section>

            <DataTable columns={columns} data={appointments.data.documents} />
          </>
        ) : (
          <DataSourceProblemNotice problem={appointments} />
        )}
      </main>
    </div>
  );
};

export default AdminPage;
