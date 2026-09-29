// Shared Tailwind theme — identical to the one used on the Recall home page.
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      "colors": {
        "inverse-primary": "#00668a",
        "on-primary-container": "#004965",
        "surface-variant": "#273647",
        "primary": "#8ed5ff",
        "surface-tint": "#7bd0ff",
        "primary-fixed": "#c4e7ff",
        "secondary-fixed-dim": "#bdc2ff",
        "background": "#051424",
        "tertiary-fixed-dim": "#ddb7ff",
        "primary-fixed-dim": "#7bd0ff",
        "on-surface": "#d4e4fa",
        "surface": "#051424",
        "on-background": "#d4e4fa",
        "on-secondary-container": "#a8afff",
        "secondary-fixed": "#e0e0ff",
        "inverse-surface": "#d4e4fa",
        "outline": "#87929a",
        "surface-bright": "#2c3a4c",
        "surface-container": "#122131",
        "tertiary-fixed": "#f0dbff",
        "on-tertiary-container": "#6400ac",
        "primary-container": "#38bdf8",
        "tertiary": "#e1bfff",
        "on-secondary-fixed-variant": "#2f3aa3",
        "error-container": "#93000a",
        "on-tertiary-fixed": "#2c0051",
        "surface-container-high": "#1c2b3c",
        "outline-variant": "#3e484f",
        "error": "#ffb4ab",
        "secondary-container": "#2f3aa3",
        "on-error": "#690005",
        "on-secondary": "#131e8c",
        "on-primary": "#00354a",
        "on-tertiary-fixed-variant": "#6900b3",
        "on-primary-fixed": "#001e2c",
        "surface-container-lowest": "#010f1f",
        "inverse-on-surface": "#233143",
        "surface-container-highest": "#273647",
        "surface-dim": "#051424",
        "secondary": "#bdc2ff",
        "on-surface-variant": "#bdc8d1",
        "surface-container-low": "#0d1c2d",
        "on-primary-fixed-variant": "#004c69",
        "on-tertiary": "#490080",
        "on-error-container": "#ffdad6",
        "on-secondary-fixed": "#000767",
        "tertiary-container": "#ce9bff"
      },
      "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" },
      "spacing": {
        "space-xs": "0.25rem", "gutter": "1.5rem", "gutter-sm": "1rem", "space-lg": "1.5rem",
        "margin-sm": "1rem", "space-sm": "0.5rem", "space-xl": "2.5rem", "space-md": "1rem", "margin": "2rem"
      },
      "fontFamily": {
        "code-inline": ["JetBrains Mono"], "display-lg": ["Plus Jakarta Sans"],
        "headline-xl-mobile": ["Plus Jakarta Sans"], "label-code": ["JetBrains Mono"],
        "code-block": ["JetBrains Mono"], "body-md": ["Inter"], "headline-md": ["Plus Jakarta Sans"],
        "body-lg": ["Inter"], "headline-lg": ["Plus Jakarta Sans"], "display-lg-mobile": ["Plus Jakarta Sans"],
        "headline-xl": ["Plus Jakarta Sans"], "label-ui": ["Inter"], "body-sm": ["Inter"]
      },
      "fontSize": {
        "code-inline": ["13px", { "lineHeight": "20px", "letterSpacing": "0em", "fontWeight": "400" }],
        "display-lg": ["48px", { "lineHeight": "56px", "letterSpacing": "-0.03em", "fontWeight": "700" }],
        "headline-xl-mobile": ["26px", { "lineHeight": "34px", "letterSpacing": "-0.015em", "fontWeight": "600" }],
        "label-code": ["11px", { "lineHeight": "16px", "letterSpacing": "0.04em", "fontWeight": "500" }],
        "code-block": ["13px", { "lineHeight": "22px", "letterSpacing": "-0.01em", "fontWeight": "400" }],
        "body-md": ["14px", { "lineHeight": "22px", "letterSpacing": "0em", "fontWeight": "400" }],
        "headline-md": ["18px", { "lineHeight": "26px", "letterSpacing": "-0.01em", "fontWeight": "600" }],
        "body-lg": ["16px", { "lineHeight": "26px", "letterSpacing": "-0.005em", "fontWeight": "400" }],
        "headline-lg": ["24px", { "lineHeight": "32px", "letterSpacing": "-0.015em", "fontWeight": "600" }],
        "display-lg-mobile": ["32px", { "lineHeight": "40px", "letterSpacing": "-0.02em", "fontWeight": "700" }],
        "headline-xl": ["36px", { "lineHeight": "44px", "letterSpacing": "-0.02em", "fontWeight": "600" }],
        "label-ui": ["12px", { "lineHeight": "16px", "letterSpacing": "0.01em", "fontWeight": "500" }],
        "body-sm": ["12px", { "lineHeight": "18px", "letterSpacing": "0.01em", "fontWeight": "400" }]
      }
    }
  }
};
