"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/api/auth-context";
import { adminApi, type Course, type CourseItem, type CourseLesson } from "@/api/admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Badge,
} from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Plus, Trash2, Edit2, Play, FileText, Mic, FileType, HelpCircle, Loader2 } from "lucide-react";
import { EmptyState } from "@/components/console/shared";

type ItemKind = CourseItem["kind"];

interface ModuleDraft {
  id: number | string;
  title: string;
  items: CourseItemDraft[];
}

interface CourseItemDraft {
  kind: ItemKind;
  text?: string;
  caption?: string;
  url?: string;
  label?: string;
  explanation?: string | null;
  options?: Array<{ label: string; correct?: boolean }>;
}

interface CourseBuilderProps {
  onComplete: (course: Course) => void;
  onClose: () => void;
  editingCourse?: Course;
}

export function CourseBuilder({ onComplete, onClose, editingCourse }: CourseBuilderProps) {
  const { session } = useAuth();
  const canManage = session?.role === "org_admin" || session?.role === "platform_admin";
  const client = useQueryClient();

  const [title, setTitle] = React.useState(editingCourse?.title ?? "");
  const [description, setDescription] = React.useState(editingCourse?.description ?? "");
  const [modules, setModules] = React.useState<ModuleDraft[]>(
    editingCourse?.lessons
      ? editingCourse.lessons.map((lesson, index) => ({
          id: lesson.id,
          title: lesson.title,
          items: lesson.items.map((item) => ({ ...item })),
        }))
      : [{ id: `new-${Date.now()}`, title: "Module 1", items: [] }],
  );
  const [newModuleTitle, setNewModuleTitle] = React.useState("");

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [screenError, setScreenError] = React.useState("");

  const createCourseMutation = useMutation({
    mutationFn: () =>
      adminApi.courses.create({
        title: title.trim(),
        description: description.trim(),
        lessons: modules.map((m) => ({ title: m.title, items: m.items })),
      }),
    onSuccess: async ({ course }) => {
      setIsSubmitting(false);
      await client.invalidateQueries({ queryKey: ["courses", "all"] });
      onComplete(course);
    },
    onError: (error) => {
      setIsSubmitting(false);
      setScreenError(error instanceof Error ? error.message : "Failed to create course");
    },
  });

  const updateCourseMutation = useMutation({
    mutationFn: () =>
      adminApi.courses.update(editingCourse!.id, {
        title: title.trim(),
        description: description.trim(),
      }),
    onSuccess: async ({ course }) => {
      setIsSubmitting(false);
      await client.invalidateQueries({ queryKey: ["courses", "all"] });
      await client.invalidateQueries({ queryKey: ["course", editingCourse!.id] });
      onComplete(course);
    },
    onError: (error) => {
      setIsSubmitting(false);
      setScreenError(error instanceof Error ? error.message : "Failed to update course");
    },
  });

  const isEditing = editingCourse !== undefined;

  const allItemsValid = modules.every((module) =>
    module.items.every((item) => {
      if (item.kind === "text" || item.kind === "link") return Boolean(item.text || item.label);
      if (item.kind === "quiz") return Boolean(item.caption && item.options?.some((o) => o.correct));
      return Boolean(item.url || item.caption);
    }),
  );

  const handleAddModule = () => {
    const title = newModuleTitle.trim() || `Module ${modules.length + 1}`;
    setModules([...modules, { id: `new-${Date.now()}`, title, items: [] }]);
    setNewModuleTitle("");
  };

  const handleRemoveModule = (index: number) => {
    setModules((current) => current.filter((_, i) => i !== index));
  };

  const handleAddItem = (moduleIndex: number, kind: ItemKind) => {
    const item: CourseItemDraft =
      kind === "quiz"
        ? { kind, caption: "", explanation: null, options: [{ label: "", correct: true }, { label: "" }] }
        : kind === "link"
          ? { kind, label: "", url: "" }
          : kind === "text"
            ? { kind, text: "" }
            : { kind, caption: "", url: "" };
    setModules((current) =>
      current.map((m, i) =>
        i === moduleIndex ? { ...m, items: [...m.items, item] } : m,
      ),
    );
  };

  const handleRemoveItem = (moduleIndex: number, itemIndex: number) => {
    setModules((current) =>
      current.map((m, i) =>
        i === moduleIndex ? { ...m, items: m.items.filter((_, j) => j !== itemIndex) } : m,
      ),
    );
  };

  const handleChangeItem = (moduleIndex: number, itemIndex: number, patch: Partial<CourseItemDraft>) => {
    setModules((current) =>
      current.map((m, i) =>
        i === moduleIndex
          ? { ...m, items: m.items.map((item, j) => (j === itemIndex ? { ...item, ...patch } : item)) }
          : m,
      ),
    );
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setScreenError("");
    if (!title.trim()) {
      setScreenError("Course title is required.");
      return;
    }
    if (!allItemsValid) {
      setScreenError("Please fill in all required fields for every module item.");
      return;
    }
    setIsSubmitting(true);
    if (isEditing) {
      updateCourseMutation.mutate();
    } else {
      createCourseMutation.mutate();
    }
  };

  if (!canManage) {
    return (
      <Card className="p-6">
        <CardHeader>
          <CardTitle>Create Course</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">You don't have permission to create courses.</p>
        </CardContent>
      </Card>
    );
  }

  const kindLabels: Record<ItemKind, string> = {
    text: "Text",
    image: "Image",
    document: "PDF / Document",
    video: "Video",
    audio: "Audio",
    link: "Link",
    quiz: "Quiz",
  };

  const kindIcons: Record<ItemKind, React.ElementType> = {
    text: FileText,
    image: FileType,
    document: FileType,
    video: Play,
    audio: Mic,
    link: HelpCircle,
    quiz: HelpCircle,
  };

  return (
    <Card className="max-w-4xl mx-auto">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>{isEditing ? "Edit Course" : "Create Course"}</CardTitle>
        <Button onClick={onClose} variant="outline" size="sm">
          Close
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {screenError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {screenError}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Course title</label>
              <Input
                required
                maxLength={100}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Introduction to Digital Marketing"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <textarea
                className="min-h-[80px] w-full rounded-md border bg-background p-2"
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this course about?"
              />
            </div>
          </div>

          <Separator />
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Modules</h3>
            <div className="flex items-center gap-2">
              <Input
                value={newModuleTitle}
                onChange={(e) => setNewModuleTitle(e.target.value)}
                placeholder="New module title"
                className="w-48"
              />
              <Button onClick={handleAddModule} size="sm" disabled={isSubmitting}>
                <Plus size={16} />
                Add Module
              </Button>
            </div>
          </div>

          {modules.map((module, moduleIndex) => (
            <Card key={module.id} className="rounded-lg border p-4 space-y-4">
              <CardHeader>
                <div className="flex items-center justify-between space-y-2 sm:space-y-0 sm:flex-row">
                  <div>
                    <label className="text-sm font-medium">Module title</label>
                    <Input
                      value={module.title}
                      onChange={(e) => {
                        setModules((current) =>
                          current.map((m, i) => (i === moduleIndex ? { ...m, title: e.target.value } : m)),
                        );
                      }}
                    />
                  </div>
                  <Button
                    onClick={() => handleRemoveModule(moduleIndex)}
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    disabled={modules.length === 1 || isSubmitting}
                  >
                    <Trash2 size={16} /> Remove
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {module.items.length === 0 ? (
                  <EmptyState>No content items yet. Add text, PDF links, audio, or quiz questions below.</EmptyState>
                ) : (
                  <div className="space-y-3">
                    {module.items.map((item, itemIndex) => (
                      <div key={itemIndex} className="rounded border p-3 bg-background/50">
                        <div className="flex items-center justify-between space-y-2 sm:space-y-0 sm:flex-row">
                          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            {kindLabels[item.kind]}
                          </span>
                          <Button
                            onClick={() => handleRemoveItem(moduleIndex, itemIndex)}
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            disabled={isSubmitting}
                          >
                            <Trash2 size={16} />
                          </Button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {item.kind === "text" ? (
                            <div className="col-span-2">
                              <label className="text-xs font-medium">Text content</label>
                              <textarea
                                className="min-h-[80px] w-full rounded-md border bg-background p-2 text-sm"
                                maxLength={1200}
                                value={item.text ?? ""}
                                onChange={(e) =>
                                  handleChangeItem(moduleIndex, itemIndex, { text: e.target.value })
                                }
                                placeholder="Enter the lesson text content..."
                              />
                            </div>
                          ) : item.kind === "audio" ? (
                            <>
                              <div className="col-span-2">
                                <label className="text-xs font-medium">Audio URL</label>
                                <Input
                                  value={item.url ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { url: e.target.value })
                                  }
                                  placeholder="https://example.com/audio.mp3"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium">Caption</label>
                                <Input
                                  value={item.caption ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { caption: e.target.value })
                                  }
                                  placeholder="Optional caption"
                                />
                              </div>
                            </>
                          ) : item.kind === "document" || item.kind === "image" || item.kind === "video" ? (
                            <>
                              <div className="col-span-2">
                                <label className="text-xs font-medium">{item.kind === "document" ? "PDF / Document URL" : item.kind === "image" ? "Image URL" : "Video URL"}</label>
                                <Input
                                  value={item.url ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { url: e.target.value })
                                  }
                                  placeholder="https://example.com/file.pdf"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium">Caption</label>
                                <Input
                                  value={item.caption ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { caption: e.target.value })
                                  }
                                  placeholder="Optional caption"
                                />
                              </div>
                            </>
                          ) : item.kind === "link" ? (
                            <>
                              <div>
                                <label className="text-xs font-medium">Link label</label>
                                <Input
                                  value={item.label ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { label: e.target.value })
                                  }
                                  placeholder="e.g. Read more"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium">URL</label>
                                <Input
                                  value={item.url ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { url: e.target.value })
                                  }
                                  placeholder="https://example.com"
                                />
                              </div>
                            </>
                          ) : (
                            // quiz
                            <>
                              <div className="col-span-2">
                                <label className="text-xs font-medium">Quiz question</label>
                                <textarea
                                  className="min-h-[80px] w-full rounded-md border bg-background p-2 text-sm"
                                  maxLength={1200}
                                  value={item.caption ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { caption: e.target.value })
                                  }
                                  placeholder="Ask a question about this module..."
                                />
                              </div>
                              <div className="col-span-2">
                                <label className="text-xs font-medium">Explanation (optional)</label>
                                <textarea
                                  className="min-h-[60px] w-full rounded-md border bg-background p-2 text-sm"
                                  maxLength={1000}
                                  value={item.explanation ?? ""}
                                  onChange={(e) =>
                                    handleChangeItem(moduleIndex, itemIndex, { explanation: e.target.value })
                                  }
                                  placeholder="Explain the correct answer..."
                                />
                              </div>
                              <div className="col-span-2">
                                <label className="text-xs font-medium">Options (one per line; prefix correct answer with *)</label>
                                <textarea
                                  className="min-h-[80px] w-full rounded-md border bg-background p-2 text-sm"
                                  value={(item.options ?? []).map((o) => `${o.correct ? "*" : ""}${o.label}`).join("\n")}
                                  onChange={(e) => {
                                    const options = e.target.value
                                      .split("\n")
                                      .filter(Boolean)
                                      .map((line) => ({
                                        label: line.replace(/^\*/, ""),
                                        ...(line.startsWith("*") ? { correct: true } : {}),
                                      }));
                                    handleChangeItem(moduleIndex, itemIndex, { options });
                                  }}
                                />
                              </div>
                            </>
                          )}
                        </div>
                        <div className="flex items-end gap-2 pt-2">
                          <span className="text-xs text-muted-foreground">
                            {item.kind === "quiz" ? "Learner picks an answer before moving on" : "Sent as a WhatsApp message"}
                          </span>
                          {(["text", "document", "audio", "link", "quiz"] as ItemKind[]).map((kind) => {
                            const Icon = kindIcons[kind];
                            return (
                              <Button
                                key={kind}
                                onClick={() => handleAddItem(moduleIndex, kind)}
                                size="sm"
                                variant="outline"
                                disabled={isSubmitting}
                              >
                                <Icon size={14} />
                                {kindLabels[kind]}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 pt-2">
                  <span className="text-xs text-muted-foreground">Add item:</span>
                  {(["text", "document", "audio", "link", "quiz"] as ItemKind[]).map((kind) => {
                    const Icon = kindIcons[kind];
                    return (
                      <Button
                        key={kind}
                        onClick={() => handleAddItem(moduleIndex, kind)}
                        size="sm"
                        variant="outline"
                        disabled={isSubmitting}
                      >
                        <Icon size={14} />
                        {kindLabels[kind]}
                      </Button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}

          <Button
            type="submit"
            disabled={isSubmitting || !title.trim() || !allItemsValid || modules.some((m) => m.items.length === 0)}
            className="w-full"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isEditing ? "Updating course…" : "Creating course…"}
              </>
            ) : (
              <>
                <Plus size={16} />
                {isEditing ? "Update Course" : "Create Course"}
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
