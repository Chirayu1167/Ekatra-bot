import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/api/auth-context";
import { adminApi } from "@/api/admin";
import type { Course, CourseItem, CourseLesson } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConsoleShell } from "@/components/console/console-shell";
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, StatusBadge } from "./shared";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

export function CoursesScreen() {
  const { session } = useAuth();
  const canManage = session?.role === "org_admin" || session?.role === "platform_admin";
  const client = useQueryClient();
  const courses = useQuery({ queryKey: ["courses", "all"], queryFn: () => adminApi.courses.list() });
  const [search, setSearch] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [creating, setCreating] = React.useState(false);
  const selected = useQuery({
    queryKey: ["course", selectedId],
    queryFn: () => adminApi.courses.get(selectedId as number),
    enabled: selectedId !== null,
  });
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [lessonDrafts, setLessonDrafts] = React.useState<CourseLesson[]>([]);
  const [newLessonTitle, setNewLessonTitle] = React.useState("");
  const [newLessonText, setNewLessonText] = React.useState("");
  const [screenError, setScreenError] = React.useState("");
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["courses"] }),
      client.invalidateQueries({ queryKey: ["course", selectedId] }),
    ]);
  };
  React.useEffect(() => {
    const course = selected.data?.course;
    if (course) {
      setTitle(course.title);
      setDescription(course.description);
      setLessonDrafts((course.lessons ?? []).map((lesson) => ({ ...lesson, items: lesson.items.map((item) => ({ ...item })) })));
    }
  }, [selected.data]);

  const createCourse = useMutation({
    mutationFn: () => adminApi.courses.create({ title: title.trim(), description: description.trim() }),
    onSuccess: async ({ course }) => {
      setCreating(false);
      setTitle("");
      setDescription("");
      setSelectedId(course.id);
      setScreenError("");
      await refresh();
    },
    onError: (error) => setScreenError(message(error)),
  });
  const saveCourse = useMutation({
    mutationFn: () => adminApi.courses.update(selectedId as number, { title: title.trim(), description: description.trim() }),
    onSuccess: refresh,
    onError: (error) => setScreenError(message(error)),
  });
  const removeCourse = useMutation({
    mutationFn: (id: number) => adminApi.courses.delete(id),
    onSuccess: async () => { setSelectedId(null); setScreenError(""); await refresh(); },
    onError: (error) => setScreenError(message(error)),
  });
  const changePublication = useMutation({
    mutationFn: ({ id, publish }: { id: number; publish: boolean }) => publish ? adminApi.courses.publish(id) : adminApi.courses.unpublish(id),
    onSuccess: refresh,
    onError: (error) => setScreenError(message(error)),
  });
  const saveLesson = useMutation({
    mutationFn: ({ lesson, isNew }: { lesson: CourseLesson; isNew: boolean }) => isNew
      ? adminApi.courses.addLesson(selectedId as number, { title: lesson.title, items: lesson.items })
      : adminApi.courses.updateLesson(selectedId as number, lesson.id, { title: lesson.title, items: lesson.items }),
    onSuccess: async (_data, variables) => {
      if (variables.isNew) {
        setNewLessonTitle("");
        setNewLessonText("");
      }
      await refresh();
    },
    onError: (error) => setScreenError(message(error)),
  });
  const deleteLesson = useMutation({
    mutationFn: (lessonId: number) => adminApi.courses.deleteLesson(selectedId as number, lessonId),
    onSuccess: refresh,
    onError: (error) => setScreenError(message(error)),
  });
  const visible = (courses.data?.courses ?? []).filter((course) => course.title.toLowerCase().includes(search.trim().toLowerCase()));

  function changeItem(lessonIndex: number, itemIndex: number, patch: Partial<CourseItem>) {
    setLessonDrafts((current) => current.map((lesson, index) => index !== lessonIndex ? lesson : ({
      ...lesson,
      items: lesson.items.map((item, itemPosition) => itemPosition === itemIndex ? { ...item, ...patch } : item),
    })));
  }
  function addItem(lessonIndex: number, kind: CourseItem["kind"]) {
    const item: CourseItem = kind === "quiz"
      ? { kind, caption: "", explanation: "", options: [{ label: "", correct: true }, { label: "" }] }
      : kind === "link" ? { kind, label: "", url: "" }
        : kind === "text" ? { kind, text: "" }
          : { kind, caption: "", url: "" };
    setLessonDrafts((current) => current.map((lesson, index) => index !== lessonIndex ? lesson : ({ ...lesson, items: [...lesson.items, item] })));
  }
  function updateLesson(lesson: CourseLesson, isNew = false) {
    if (lesson.items.length === 0) {
      setScreenError("A lesson needs at least one content item.");
      return;
    }
    setScreenError("");
    saveLesson.mutate({ lesson, isNew });
  }
  function startCreate() {
    setCreating(true);
    setSelectedId(null);
    setTitle("");
    setDescription("");
    setScreenError("");
  }

  return (
    <ConsoleShell title="Courses">
      {screenError && <ErrorState message={screenError} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input aria-label="Search courses" className="max-w-sm" onChange={(event) => setSearch(event.target.value)} placeholder="Search courses" value={search} />
        {canManage && <Button onClick={startCreate}>Create course</Button>}
      </div>
      {courses.isLoading ? <LoadingState>Loading courses…</LoadingState>
        : courses.isError ? <ErrorState message={message(courses.error)} />
          : visible.length === 0 ? <EmptyState>No courses found.</EmptyState>
            : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((course) => <CourseCard course={course} key={course.id} onSelect={() => { setSelectedId(course.id); setCreating(false); setScreenError(""); }} />)}
            </div>}

      {(creating || selectedId !== null) && (
        <section aria-label={creating ? "Create course form" : "Edit course"} className="space-y-5 rounded-lg border p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{creating ? "New course" : selected.data?.course.title ?? "Edit course"}</h2>
            <Button onClick={() => { setSelectedId(null); setCreating(false); }} variant="outline">Close</Button>
          </div>
          {selectedId !== null && selected.isLoading ? <LoadingState>Loading course…</LoadingState>
            : selectedId !== null && selected.isError ? <ErrorState message={message(selected.error)} />
              : !canManage && selected.data ? (
                <div className="space-y-4">
                  <h2 className="font-semibold">{selected.data.course.title}</h2>
                  <p className="text-sm text-muted-foreground">{selected.data.course.description}</p>
                  {(selected.data.course.lessons ?? []).map((lesson) => (
                    <article className="rounded-md border p-4" key={lesson.id}>
                      <h3 className="font-medium">{lesson.title}</h3>
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                        {lesson.items.map((item, index) => <li key={index}>{item.caption || item.text || item.label || item.url || item.kind}</li>)}
                      </ol>
                    </article>
                  ))}
                </div>
              )
              : <>
                <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); if (creating) createCourse.mutate(); else saveCourse.mutate(); }}>
                  <label className="space-y-1 text-sm">Course title<Input maxLength={100} onChange={(event) => setTitle(event.target.value)} required value={title} /></label>
                  <label className="space-y-1 text-sm">Description<textarea className="min-h-10 w-full rounded-md border bg-background p-2" maxLength={500} onChange={(event) => setDescription(event.target.value)} value={description} /></label>
                  <div><Button disabled={createCourse.isPending || saveCourse.isPending} type="submit">{creating ? "Create course" : "Save course"}</Button></div>
                </form>
                {!creating && selected.data && <>
                  <div className="flex flex-wrap gap-2">
                    <ConfirmDialog
                      description={selected.data.course.status === "published" ? "Learners will no longer receive this course." : "This makes the course available for enrollment."}
                      label={selected.data.course.status === "published" ? "Unpublish course?" : "Publish course?"}
                      onConfirm={() => changePublication.mutate({ id: selectedId as number, publish: selected.data?.course.status !== "published" })}
                    >{selected.data.course.status === "published" ? "Unpublish" : "Publish"}</ConfirmDialog>
                    <ConfirmDialog description="The server will prevent deletion when this course has dependent records." label="Delete course?" onConfirm={() => removeCourse.mutate(selectedId as number)}>Delete</ConfirmDialog>
                  </div>
                  <div className="space-y-4">
                    <h3 className="font-semibold">Lessons and content</h3>
                    {lessonDrafts.map((lesson, lessonIndex) => (
                      <article className="space-y-3 rounded-md border p-4" key={lesson.id}>
                        <div className="flex items-end gap-2">
                          <label className="flex-1 space-y-1 text-sm">Lesson title<Input maxLength={80} onChange={(event) => setLessonDrafts((current) => current.map((row, i) => i === lessonIndex ? { ...row, title: event.target.value } : row))} value={lesson.title} /></label>
                          <Button disabled={saveLesson.isPending} onClick={() => updateLesson(lesson)} type="button">Save lesson</Button>
                          <ConfirmDialog description="The lesson and its content will be removed." label="Delete lesson?" onConfirm={() => deleteLesson.mutate(lesson.id)}>Delete</ConfirmDialog>
                        </div>
                        {lesson.items.map((item, itemIndex) => <div className="grid gap-2 rounded border p-3 md:grid-cols-2" key={`${lesson.id}-${itemIndex}`}>
                          <label className="space-y-1 text-xs">Content type
                            <select aria-label="Content type" className="h-10 w-full rounded-md border bg-background px-2 text-sm" onChange={(event) => {
                              const kind = event.target.value as CourseItem["kind"];
                              const replacement: CourseItem = kind === "quiz" ? { kind, caption: "", explanation: "", options: [{ label: "", correct: true }, { label: "" }] } : kind === "text" ? { kind, text: "" } : kind === "link" ? { kind, label: "", url: "" } : { kind, caption: "", url: "" };
                              setLessonDrafts((current) => current.map((row, i) => i !== lessonIndex ? row : ({ ...row, items: row.items.map((old, j) => j === itemIndex ? replacement : old) })));
                            }} value={item.kind}>
                              {["text", "image", "document", "video", "audio", "link", "quiz"].map((kind) => <option key={kind}>{kind}</option>)}
                            </select>
                          </label>
                          {item.kind === "quiz" ? <>
                            <label className="space-y-1 text-xs">Question<textarea className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" maxLength={1200} onChange={(event) => changeItem(lessonIndex, itemIndex, { caption: event.target.value })} value={item.caption ?? ""} /></label>
                            <label className="space-y-1 text-xs">Explanation ({(item.explanation ?? "").length}/1000)<textarea className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" maxLength={1000} onChange={(event) => changeItem(lessonIndex, itemIndex, { explanation: event.target.value })} value={item.explanation ?? ""} /></label>
                            <label className="space-y-1 text-xs">Options (one per line; prefix the correct answer with *)<textarea className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" onChange={(event) => {
                              const options = event.target.value.split("\n").filter(Boolean).map((line) => ({ label: line.replace(/^\*/, ""), ...(line.startsWith("*") ? { correct: true } : {}) }));
                              changeItem(lessonIndex, itemIndex, { options });
                            }} value={(item.options ?? []).map((option) => `${option.correct ? "*" : ""}${option.label}`).join("\n")} /></label>
                          </> : <>
                            <label className="space-y-1 text-xs">{item.kind === "text" ? "Text" : item.kind === "link" ? "Link label" : "Caption"}<textarea className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" maxLength={item.kind === "text" ? 1200 : 800} onChange={(event) => changeItem(lessonIndex, itemIndex, item.kind === "text" ? { text: event.target.value } : item.kind === "link" ? { label: event.target.value } : { caption: event.target.value })} value={item.kind === "text" ? item.text ?? "" : item.kind === "link" ? item.label ?? "" : item.caption ?? ""} /></label>
                            {item.kind !== "text" && <label className="space-y-1 text-xs">URL<Input onChange={(event) => changeItem(lessonIndex, itemIndex, { url: event.target.value })} value={item.url ?? ""} /></label>}
                          </>}
                          <Button onClick={() => setLessonDrafts((current) => current.map((row, i) => i !== lessonIndex ? row : ({ ...row, items: row.items.filter((_, j) => j !== itemIndex) })))} type="button" variant="outline">Remove item</Button>
                        </div>)}
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm">Add item:</span>
                          {(["text", "image", "document", "video", "audio", "link", "quiz"] as CourseItem["kind"][]).map((kind) => <Button key={kind} onClick={() => addItem(lessonIndex, kind)} size="sm" type="button" variant="outline">{kind}</Button>)}
                        </div>
                      </article>
                    ))}
                    <form className="grid gap-2 md:grid-cols-[1fr_2fr_auto]" onSubmit={(event) => {
                      event.preventDefault();
                      updateLesson({ id: 0, courseId: selectedId as number, position: lessonDrafts.length + 1, title: newLessonTitle.trim(), items: [{ kind: "text", text: newLessonText.trim() }] }, true);
                    }}>
                      <Input aria-label="New lesson title" maxLength={80} onChange={(event) => setNewLessonTitle(event.target.value)} placeholder="New lesson title" required value={newLessonTitle} />
                      <Input aria-label="First lesson text item" maxLength={1200} onChange={(event) => setNewLessonText(event.target.value)} placeholder="First lesson text item" required value={newLessonText} />
                      <Button disabled={saveLesson.isPending} type="submit">Add lesson</Button>
                    </form>
                  </div>
                </>}
              </>}
        </section>
      )}
    </ConsoleShell>
  );
}

function CourseCard({ course, onSelect }: { course: Course; onSelect: () => void }) {
  return <button className="flex items-start justify-between gap-3 rounded-lg border p-4 text-left hover:bg-muted/40" onClick={onSelect} type="button">
    <span><span className="block font-medium">{course.title}</span><span className="text-sm text-muted-foreground">{course.lessonCount} lessons</span></span>
    <StatusBadge status={course.status} />
  </button>;
}
