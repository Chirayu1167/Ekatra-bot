"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router-compat";
import { useAuth } from "@/api/auth-context";
import { adminApi, type Course } from "@/api/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  MoreHorizontal,
  Search,
  Archive,
  Copy,
  Edit,
  Trash2,
  Eye,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { EmptyState } from "@/components/console/shared";
import { ConsoleShell } from "@/components/console/console-shell";
import { CourseBuilder } from "@/components/console/course-builder";

function statusVariant(status: string) {
  switch (status) {
    case "published": return "default";
    case "draft": return "outline";
    default: return "secondary";
  }
}

export const Route = createFileRoute("/courses")({
  component: CoursesScreen,
});

function CoursesScreen() {
  const { session } = useAuth();
  const canManage = session?.role === "org_admin" || session?.role === "platform_admin";
  const navigate = useNavigate();
  const client = useQueryClient();

  const [searchTerm, setSearchTerm] = React.useState("");
  const [showBuilder, setShowBuilder] = React.useState(false);
  const [editingCourseId, setEditingCourseId] = React.useState<number | null>(null);

  const coursesQuery = useQuery({
    queryKey: ["courses", "all"],
    queryFn: () => adminApi.courses.list(),
  });

  const filteredCourses = (coursesQuery.data?.courses ?? []).filter((course) =>
    course.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const deleteMutation = useMutation({
    mutationFn: (id: number) => adminApi.courses.delete(id),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["courses"] });
      setEditingCourseId(null);
      toast("Course deleted", { description: "The course has been removed." });
    },
    onError: (error) => {
      toast("Error", {
        description: `Failed to delete course: ${(error as Error).message}`,
      });
    },
  });

  const handleEditCourse = (course: Course) => {
    setEditingCourseId(course.id);
    setShowBuilder(true);
  };

  const handleViewCourse = (course: Course) => {
    navigate(`/courses/preview/${course.id}`);
  };

  const handleDeleteCourse = (course: Course) => {
    setEditingCourseId(course.id);
    deleteMutation.mutate(course.id);
  };

  const handleCreateCourse = () => {
    setEditingCourseId(null);
    setShowBuilder(true);
  };

  if (coursesQuery.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <ConsoleShell title="Courses">
      {showBuilder && (
        <CourseBuilder
          onComplete={() => {
            setShowBuilder(false);
            setEditingCourseId(null);
          }}
          onClose={() => setShowBuilder(false)}
          editingCourse={editingCourseId ? (coursesQuery.data?.courses ?? []).find((c) => c.id === editingCourseId) ?? undefined : undefined}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Courses</h1>
          <p className="text-sm text-muted-foreground">
            Manage your learning courses and lessons
          </p>
        </div>
        {canManage && (
          <Button onClick={handleCreateCourse}>
            <Plus size={16} className="mr-2" />
            Create Course
          </Button>
        )}
      </div>

      <div className="relative">
        <Input
          placeholder="Search courses by title…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full max-w-md"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead className="text-center">Modules</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[160px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCourses.length > 0 ? (
                  filteredCourses.map((course) => (
                    <TableRow key={course.id}>
                      <TableCell className="font-medium">{course.title}</TableCell>
                      <TableCell className="text-center">{course.lessonCount}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant={statusVariant(course.status)}>
                          {course.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{new Date(course.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button variant="ghost" size="icon" onClick={() => handleViewCourse(course)}>
                            <Eye className="h-4 w-4" />
                            <span className="sr-only">View</span>
                          </Button>
                          {canManage && (
                            <Button variant="ghost" size="icon" onClick={() => handleEditCourse(course)}>
                              <Edit className="h-4 w-4" />
                              <span className="sr-only">Edit</span>
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">Open menu</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => handleEditCourse(course)}>
                                <Edit className="mr-2 h-4 w-4" />
                                Edit module
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleViewCourse(course)}>
                                <Eye className="mr-2 h-4 w-4" />
                                View
                              </DropdownMenuItem>
                              {canManage && (
                                <>
                                  <DropdownMenuSeparator />
                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <DropdownMenuItem className="text-destructive" onSelect={(e) => e.preventDefault()}>
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
                                      </DropdownMenuItem>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent className="p-6">
                                      <div className="space-y-4">
                                        <AlertDialogTitle>Delete course?</AlertDialogTitle>
                                        <AlertDialogDescription>
                                          This will permanently delete "{course.title}" and all associated data.
                                        </AlertDialogDescription>
                                      </div>
                                      <div className="flex justify-end gap-2 pt-4">
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction
                                          onClick={() => handleDeleteCourse(course)}
                                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        >
                                          Delete
                                        </AlertDialogAction>
                                      </div>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                      No courses found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </ConsoleShell>
  );
}
