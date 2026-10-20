import type { ReplyMessage } from '../services/delivery';
import type { LessonItem } from '../types/course';

/** Content Template SIDs for tap-buttons. A button set that is absent keeps typed-command text. */
export interface LessonButtons {
  /** Next / Pause, shown after every lesson except the last. */
  next?: string | undefined;
  /** Courses, shown after the last lesson. */
  courses?: string | undefined;
  /** Quiz answer buttons (A, B, C, D) */
  quiz?: string | undefined;
}

export interface LessonContext {
  courseTitle: string;
  lessonNumber: number;
  lessonCount: number;
  lessonTitle: string;
}

/**
 * Turn one lesson into the ordered WhatsApp messages to send.
 *
 *  - Text and links are plain text messages.
 *  - Every media file is its OWN message with no body (WhatsApp allows one media object per
 *    message, and Twilio documents captions as unreliable). A caption becomes a text message
 *    sent just before the file.
 *  - A header ("Lesson 2 of 5: ...") is merged into the first text message, and a footer
 *    (what to send next, or the completion note) into the last one. Each becomes its own
 *    message only when the neighbouring message is a media file.
 *  - With button templates configured, the footer is instead a separate message with
 *    tap-buttons (Next/Pause, or Courses after the last lesson).
 */
export function renderLesson(
  ctx: LessonContext,
  items: LessonItem[],
  buttons: LessonButtons = {},
): ReplyMessage[] {
  const messages: ReplyMessage[] = [];

  for (const item of items) {
    switch (item.kind) {
      case 'text':
        messages.push({ text: item.text });
        break;
      case 'link':
        messages.push({ text: item.label ? `🔗 ${item.label}: ${item.url}` : `🔗 ${item.url}` });
        break;
      case 'quiz': {
        // Quiz question with answer buttons (only when the template covers every option).
        const letters = item.options.map((_, i) => String.fromCharCode(65 + i));
        const optionsText = item.options.map((opt, i) => `${letters[i]}) ${opt.label}`).join('\n');
        const quizText = `${item.caption}\n\n${optionsText}\n\nReply with the letter (${letters.join(', ')}) or tap a button.`;
        messages.push({ text: quizText });
        if (buttons.quiz && item.options.length <= 3) {
          messages.push({
            text: `Choose your answer:`,
            contentSid: buttons.quiz,
            fallbackText: `Reply with ${letters.join(', ')}.`,
          });
        }
        break;
      }
      default:
        if (item.caption) messages.push({ text: item.caption });
        messages.push({ text: '', mediaUrl: item.url });
    }
  }

  const header = `📘 *Lesson ${ctx.lessonNumber} of ${ctx.lessonCount}: ${ctx.lessonTitle}*`;
  const first = messages[0];
  if (first && !first.mediaUrl) first.text = `${header}\n\n${first.text}`;
  else messages.unshift({ text: header });

  const lastItem = items[items.length - 1];
  const endsWithQuiz = lastItem?.kind === 'quiz';

  // When a lesson ends with a quiz, do not append the NEXT/footer prompt here.
  // The quiz answer handler (courseBot.handleQuizAnswer) supplies the NEXT hint
  // only after the learner answers, so quiz and NEXT never arrive together.
  if (!endsWithQuiz) {
    const isFinal = ctx.lessonNumber >= ctx.lessonCount;
    const footer = isFinal
      ? `🎉 That was the last lesson — you've completed *${ctx.courseTitle}*!\n\nSend COURSES to find another course.`
      : `Reply *NEXT* for lesson ${ctx.lessonNumber + 1} of ${ctx.lessonCount}.`;

    const buttonSid = isFinal ? buttons.courses : buttons.next;
    if (buttonSid) {
      messages.push({
        text: isFinal
          ? `🎉 That was the last lesson — you've completed *${ctx.courseTitle}*! Tap Courses to find another.`
          : `Ready for lesson ${ctx.lessonNumber + 1} of ${ctx.lessonCount}? Tap Next or reply NEXT.`,
        contentSid: buttonSid,
        fallbackText: footer,
      });
    } else {
      const last = messages[messages.length - 1];
      if (last && !last.mediaUrl) last.text = `${last.text}\n\n${footer}`;
      else messages.push({ text: footer });
    }
  }

  return messages;
}
