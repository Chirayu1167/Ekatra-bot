"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/api/auth-context";
import { adminApi, type Course, type Learner, type DeliveryMessage, type Failure } from "@/api/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Stats } from "@/components/dashboard/Stats";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ROUTES } from "@/lib/constants";
import { EmptyState } from "@/components/console/shared";
import { ConsoleShell } from "@/components/console/console-shell";
import { CourseBuilder } from "@/components/console/course-builder";
import { Plus } from "lucide-react";

interface DashboardStat {
  name: string;
  value: string | number;
  change: string;
  trend: "up" | "down" | "neutral";
}

function computeStats(
  courses: Course[],
  learners: Learner[],
  deliveries: DeliveryMessage[],
  failures: Failure[],
): DashboardStat[] {
  const totalCourses = courses.length;
  const publishedCourses = courses.filter((c) => c.status === "published").length;
  const totalLearners = learners.length;
  const activeLearners = learners.filter((l) => l.status === "active").length;
  const totalMessages = deliveries.length;
  const failedMessages = failures.filter((f) => f.status === "open").length;

  return [
    {
      name: "Total Courses",
      value: totalCourses,
      change: `${publishedCourses} published`,
      trend: "neutral",
    },
    {
      name: "Active Learners",
      value: activeLearners,
      change: `${totalLearners} total`,
      trend: "up",
    },
    {
      name: "Messages Sent",
      value: totalMessages,
      change: `${failedMessages} failed`,
      trend: totalMessages > 0 ? "up" : "neutral",
    },
    {
      name: "Open Failures",
      value: failedMessages,
      change: "needs attention",
      trend: failedMessages > 0 ? "down" : "up",
    },
  ];
}

export const Route = createFileRoute("/dashboard")({
  component: DashboardScreen,
});

function DashboardScreen() {
  const { session } = useAuth();
  const canManage = session?.role === "org_admin" || session?.role === "platform_admin";
  const [showBuilder, setShowBuilder] = React.useState(false);

  const coursesQuery = useQuery({
    queryKey: ["dashboard", "courses"],
    queryFn: () => adminApi.courses.list(),
  });
  const learnersQuery = useQuery({
    queryKey: ["dashboard", "learners"],
    queryFn: () => adminApi.learners.list(),
  });
  const deliveryQuery = useQuery({
    queryKey: ["dashboard", "delivery"],
    queryFn: () => adminApi.delivery.list({ pageSize: 1 }),
  });
  const failuresQuery = useQuery({
    queryKey: ["dashboard", "failures"],
    queryFn: () => adminApi.failures.list({ limit: 1 }),
  });

  const loading = coursesQuery.isPending || learnersQuery.isPending || deliveryQuery.isPending || failuresQuery.isPending;

  const stats = computeStats(
    coursesQuery.data?.courses ?? [],
    learnersQuery.data?.learners ?? [],
    deliveryQuery.data?.messages ?? [],
    failuresQuery.data?.failures ?? [],
  );

  const courses = (coursesQuery.data?.courses ?? []).slice(0, 6);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <ConsoleShell title="Overview">
      {showBuilder && (
        <CourseBuilder
          onComplete={() => {
            setShowBuilder(false);
          }}
          onClose={() => setShowBuilder(false)}
        />
      )}
      <Stats stats={stats} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Courses</h2>
          <p className="text-sm text-muted-foreground">
            {courses.length} course{courses.length !== 1 ? "s" : ""} available for learners
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setShowBuilder(true)}>
            <Plus size={16} className="mr-2" />
            Create Course
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {courses.length > 0 ? (
          courses.map((course) => (
            <Card key={course.id} className="hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => {
              window.location.href = `${ROUTES.COURSES}`;
            }}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{course.title}</span>
                  <Badge variant={course.status === "published" ? "default" : "outline"}>
                    {course.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-3">
                  {course.lessonCount} module{course.lessonCount !== 1 ? "s" : ""}
                  <span className="mx-1">•</span>
                  {new Date(course.updatedAt).toLocaleDateString()}
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {course.description || "No description"}
                </p>
                <div className="mt-3 pt-3 border-t flex items-center justify-between">
                  <Link to={ROUTES.COURSES} className="text-sm text-primary hover:underline">
                    View details
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {course.lessonCount} lesson{course.lessonCount !== 1 ? "s" : ""}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="col-span-full">
            <EmptyState>
              No courses yet. <span className="cursor-pointer font-medium underline" onClick={() => setShowBuilder(true)}>Create your first course</span> to get started.
            </EmptyState>
          </div>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="card-header">
            <h3 className="card-title">Recent Learners</h3>
          </div>
          <CardContent>
            {learnersQuery.data?.learners?.length ? (
              <div className="space-y-3">
                {learnersQuery.data.learners.slice(0, 5).map((learner) => (
                  <div key={learner.id} className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors">
                    <div>
                      <div className="font-medium">{learner.name}</div>
                      <div className="text-xs text-muted-foreground">{learner.course}</div>
                    </div>
                    <Badge variant="outline">{learner.status}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>No learners enrolled yet.</EmptyState>
            )}
          </CardContent>
        </Card>

        <Card>
          <div className="card-header">
            <h3 className="card-title">Open Failures</h3>
          </div>
          <CardContent>
            {failuresQuery.data?.failures?.length ? (
              <div className="space-y-3">
                {failuresQuery.data.failures.slice(0, 5).map((failure) => (
                  <div key={failure.id} className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors">
                    <div>
                      <div className="font-medium">{failure.reasonCode}</div>
                      <div className="text-xs text-muted-foreground">{failure.reason}</div>
                    </div>
                    <Badge variant="destructive" className="text-xs">
                      {failure.status}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>No open failures.</EmptyState>
            )}
          </CardContent>
        </Card>
      </div>
    </ConsoleShell>
  );
}
