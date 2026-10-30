import { defineWords } from "@tomradex/domain";

/** What the picture's conversation says to the person: its title and the ask it opens with. */
export const THEME_IMAGE_WORDS = defineWords("theme-image", {
  en: {
    title: "Theme from {{name}}",
    ask: "Make Tomrade's colour theme from this picture: look at it, choose the colours, and call theme_from_picture. Then tell me in a sentence or two what you chose.",
    noProject: "A theme from a picture is made in a conversation, and conversations live in a project: create a project first"
  },
  zh: {
    title: "{{name}} 的主题",
    ask: "按这张图片做 Tomrade 的配色主题：看图挑选颜色，然后调用 theme_from_picture。最后用一两句话告诉我你选了什么。",
    noProject: "图片主题是在会话里做的，而会话属于项目：先建一个项目"
  }
});
