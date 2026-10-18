import type { CourseCreateInput, LessonItem } from '../types/course';

/**
 * Sample content for local testing (`npm run seed`). Media files live in ./media and are served
 * at `${PUBLIC_BASE_URL}/media/...`. Without a public base URL the media lessons fall back to
 * text only, so seeding never produces a URL Twilio could not fetch.
 */
export function sampleCourses(mediaBaseUrl?: string): CourseCreateInput[] {
  const mediaItems: LessonItem[] = mediaBaseUrl
    ? [
        {
          kind: 'image',
          url: `${mediaBaseUrl}/media/sample.png`,
          caption: 'Here is a sample image.',
        },
        {
          kind: 'document',
          url: `${mediaBaseUrl}/media/sample.pdf`,
          caption: 'And a PDF handout.',
        },
      ]
    : [];

  return [
    {
      title: 'Welcome to Ekatra (sample)',
      slug: 'welcome-to-ekatra',
      description: 'A short sample course showing text, links, an image and a PDF on WhatsApp.',
      lessons: [
        {
          title: 'How this works',
          items: [
            {
              kind: 'text',
              text: 'Welcome! Lessons arrive one at a time. Reply NEXT when you are ready for the next one, PAUSE to take a break, and PROGRESS to see where you are.',
            },
          ],
        },
        {
          title: 'Links and reading',
          items: [
            { kind: 'text', text: 'Lessons can include links to further reading.' },
            {
              kind: 'link',
              label: 'About lifelong learning',
              url: 'https://en.wikipedia.org/wiki/Lifelong_learning',
            },
          ],
        },
        {
          title: 'Pictures and PDFs',
          items: [
            {
              kind: 'text',
              text: mediaBaseUrl
                ? 'Lessons can also include images and documents:'
                : 'Lessons can also include images and documents. (Set PUBLIC_BASE_URL before seeding to include sample attachments.)',
            },
            ...mediaItems,
          ],
        },
      ],
    },
    {
      title: 'Study habits (sample)',
      slug: 'study-habits',
      description: 'Three quick lessons on learning effectively.',
      lessons: [
        {
          title: 'Little and often',
          items: [
            {
              kind: 'text',
              text: 'Short, regular sessions beat one long cram. Aim for 15 focused minutes a day.',
            },
            {
              kind: 'quiz',
              caption: 'How long should a focused daily session be?',
              options: [
                { label: '15 focused minutes', correct: true },
                { label: 'One 3-hour cram' },
                { label: 'Skip studying' },
              ],
            },
          ],
        },
        {
          title: 'Test yourself',
          items: [
            {
              kind: 'text',
              text: 'After each lesson, try to recall the key points from memory before moving on.',
            },
            {
              kind: 'quiz',
              caption: 'What should you do after each lesson?',
              options: [
                { label: 'Recall key points from memory', correct: true },
                { label: 'Reread notes quickly' },
                { label: 'Move on immediately' },
              ],
            },
          ],
        },
        {
          title: 'Quick check',
          items: [
            { kind: 'text', text: 'Short, regular study sessions work better than one long cram. Testing yourself with recall after each lesson helps you remember.' },
            {
              kind: 'quiz',
              caption: 'Which approach does this course recommend for studying?',
              options: [
                { label: 'One long cram session' },
                { label: 'Short sessions, often', correct: true },
                { label: 'Never test yourself' },
              ],
            },
          ],
        },
      ],
    },
    {
      title: 'Demo 1',
      slug: 'demo-1',
      description: 'A quick demo with text and a link.',
      lessons: [
        {
          title: 'Hello',
          items: [{ kind: 'text', text: 'This is Demo 1, lesson 1. Reply NEXT to continue.' }],
        },
        {
          title: 'A link',
          items: [
            { kind: 'text', text: 'Lessons can point to further reading.' },
            { kind: 'link', label: 'Learn more', url: 'https://en.wikipedia.org/wiki/Education' },
          ],
        },
        {
          title: 'Done',
          items: [{ kind: 'text', text: 'That was the last lesson of Demo 1. Try Demo 2 next!' }],
        },
      ],
    },
    {
      title: 'Demo 2',
      slug: 'demo-2',
      description: 'A quick demo with an image and a PDF.',
      lessons: [
        {
          title: 'Hello',
          items: [{ kind: 'text', text: 'This is Demo 2, lesson 1. Reply NEXT to continue.' }],
        },
        {
          title: 'Image and PDF',
          items: [
            {
              kind: 'text',
              text: mediaBaseUrl
                ? 'Here is an image and a PDF:'
                : 'Lessons can include an image and a PDF. (Set PUBLIC_BASE_URL before seeding to include them.)',
            },
            ...mediaItems,
          ],
        },
        {
          title: 'Done',
          items: [
            { kind: 'text', text: 'That was the last lesson of Demo 2. Thanks for trying it!' },
          ],
        },
      ],
    },
    {
      title: 'Python Basics',
      slug: 'python-basics',
      description: 'Learn Python fundamentals: variables, data types, control flow, functions, and data structures. 10 lessons with code examples and quizzes.',
      lessons: [
        {
          title: 'Introduction to Python and Running a Program',
          items: [
            { kind: 'text', text: 'Python is a popular, beginner-friendly programming language. You write code in .py files and run them with `python filename.py`.' },
            { kind: 'text', text: 'Example: Create `hello.py` with `print("Hello, World!")` and run `python hello.py`.' },
            { kind: 'quiz', caption: 'What command runs a Python file named `test.py`?', options: [{ label: 'python test.py', correct: true }, { label: 'run test.py' }, { label: 'execute test.py' }] },
          ],
        },
        {
          title: 'Variables and Basic Data Types',
          items: [
            { kind: 'text', text: 'Variables store data: `name = "Alice"` (string), `age = 25` (integer), `height = 5.7` (float), `is_student = True` (boolean).' },
            { kind: 'text', text: 'Use `type(variable)` to check the type. Strings use quotes, numbers do not.' },
            { kind: 'quiz', caption: 'What is the type of `x = 42`?', options: [{ label: 'str' }, { label: 'int', correct: true }, { label: 'float' }] },
          ],
        },
        {
          title: 'Input, Output, and Type Conversion',
          items: [
            { kind: 'text', text: '`input()` reads text from the user. It always returns a string. Convert with `int()`, `float()`, `str()`.' },
            { kind: 'text', text: 'Example: `age = int(input("Age: "))` converts input to integer. `print(f"You are {age}")` formats output.' },
            { kind: 'quiz', caption: 'What does `input()` return?', options: [{ label: 'int' }, { label: 'string', correct: true }, { label: 'float' }] },
          ],
        },
        {
          title: 'Operators and Expressions',
          items: [
            { kind: 'text', text: 'Arithmetic: +, -, *, /, // (floor division), % (modulo), ** (power). Comparison: ==, !=, <, >, <=, >=' },
            { kind: 'text', text: 'Logical: and, or, not. Example: x > 0 and x < 10 checks if x is between 1 and 9.' },
            { kind: 'quiz', caption: 'What is 7 // 2?', options: [{ label: '3.5' }, { label: '3', correct: true }, { label: '4' }] },
          ],
        },
        {
          title: 'Conditional Statements',
          items: [
            { kind: 'text', text: 'if, elif, else control flow. Indentation matters! Example:\nif score >= 90:\n    print("A")\nelif score >= 80:\n    print("B")\nelse:\n    print("C")' },
            { kind: 'text', text: 'Conditions can combine with and, or, not. if age >= 18 and has_id: print("Allowed")' },
            { kind: 'quiz', caption: 'What prints if x = 5 and the code checks `if x > 10` else?', options: [{ label: 'big' }, { label: 'small', correct: true }, { label: 'nothing' }] },
          ],
        },
        {
          title: 'Loops',
          items: [
            { kind: 'text', text: '`for` loops iterate over sequences: `for i in range(3): print(i)` prints 0, 1, 2. `while` loops repeat while a condition is true.' },
            { kind: 'text', text: 'Break exits a loop early. Continue skips to the next iteration. `else` on a loop runs if no `break` occurred.' },
            { kind: 'quiz', caption: 'How many times does `for i in range(3):` loop?', options: [{ label: '2' }, { label: '3', correct: true }, { label: '4' }] },
          ],
        },
        {
          title: 'Lists and Tuples',
          items: [
            { kind: 'text', text: 'Lists are mutable: `fruits = ["apple", "banana"]`. Add with `append()`, access with index `fruits[0]`. Slice with `fruits[1:3]`.' },
            { kind: 'text', text: 'Tuples are immutable: `coords = (10, 20)`. Use for fixed collections. Both support `len()`, `in`, and iteration.' },
            { kind: 'quiz', caption: 'What is `fruits[1]` if `fruits = ["a", "b", "c"]`?', options: [{ label: 'a' }, { label: 'b', correct: true }, { label: 'c' }] },
          ],
        },
        {
          title: 'Dictionaries and Sets',
          items: [
            { kind: 'text', text: 'Dictionaries map keys to values: `person = {"name": "Alice", "age": 30}`. Access with `person["name"]`. Add/update with `person["city"] = "NYC"`.' },
            { kind: 'text', text: 'Sets store unique values: `unique = {1, 2, 2, 3}` becomes `{1, 2, 3}`. Useful for deduplication and membership testing.' },
            { kind: 'quiz', caption: 'How do you get the value for key "age"?', options: [{ label: 'person.age' }, { label: 'person["age"]', correct: true }, { label: 'person.get(age)' }] },
          ],
        },
        {
          title: 'Functions',
          items: [
            { kind: 'text', text: 'Functions group reusable code: `def greet(name):\n    return f"Hello, {name}!"\nprint(greet("Bob"))`. Parameters can have defaults: `def greet(name="Friend"):`.' },
            { kind: 'text', text: 'Return multiple values with tuples: `def min_max(nums):\n    return min(nums), max(nums)`' },
            { kind: 'quiz', caption: 'What does `add(3)` return for `def add(a, b=5)`?', options: [{ label: '3' }, { label: '8', correct: true }, { label: 'error' }] },
          ],
        },
        {
          title: 'Revision Quiz',
          items: [
            { kind: 'quiz', caption: '1. What keyword defines a function?', options: [{ label: 'function' }, { label: 'def', correct: true }, { label: 'func' }] },
            { kind: 'quiz', caption: '2. Which is immutable: list or tuple?', options: [{ label: 'list' }, { label: 'tuple', correct: true }, { label: 'both' }] },
            { kind: 'quiz', caption: '3. What does `len("hello")` return?', options: [{ label: '5', correct: true }, { label: '6' }, { label: 'error' }] },
            { kind: 'quiz', caption: '4. Which loop is best for a known number of iterations?', options: [{ label: 'while' }, { label: 'for', correct: true }, { label: 'if' }] },
            { kind: 'quiz', caption: '5. What is `{"a": 1}["a"]`?', options: [{ label: '1', correct: true }, { label: '"a"' }, { label: 'error' }] },
            { kind: 'text', text: '🎉 Congratulations! You completed Python Basics. Try building a small project next!' },
          ],
        },
      ],
    },
  ];
}
