# Kafka Visualiser

A React-based Kafka visualization tool built with Vite and configured for GitHub Pages deployment.

## Getting Started

### Prerequisites

- Node.js (version 14 or higher)
- npm or yarn
- Git

### Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

To start the development server:

```bash
npm run dev
```

The application will be available at `http://localhost:5173`

### Building for Production

To build the project for production:

```bash
npm run build
```

The built files will be in the `dist` directory.

## GitHub Pages Deployment

This project is configured for easy deployment to GitHub Pages.

### Setup

1. Create a new repository on GitHub named `kafka-visualiser`
2. Push this code to the repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/kafka-visualiser.git
   git push -u origin main
   ```

### Deploy

To deploy to GitHub Pages:

```bash
npm run deploy
```

This command will:
1. Build the project
2. Create/update the `gh-pages` branch
3. Push the built files to GitHub Pages

Your site will be available at: `https://YOUR_USERNAME.github.io/kafka-visualiser/`

### Configuration Notes

- The project uses `HashRouter` for client-side routing compatibility with GitHub Pages
- The `base` path in `vite.config.js` is set to `/kafka-visualiser/` for proper asset loading
- The `homepage` field in `package.json` should match your GitHub Pages URL

## Project Structure

```
kafka-visualiser/
├── public/
│   └── index.html          # HTML template
├── src/
│   ├── components/         # React components
│   │   └── Home.jsx       # Main home component (replace with your visualizer)
│   ├── App.jsx            # Main App component with routing
│   ├── App.css            # App styles
│   ├── index.css          # Global styles
│   └── main.jsx           # React entry point
├── package.json           # Dependencies and scripts
├── vite.config.js         # Vite configuration
└── README.md             # This file
```

## Customization

Replace the placeholder `Home` component in `src/components/Home.jsx` with your Kafka visualizer components. You can:

1. Add your existing components to the `src/components/` directory
2. Update the routing in `App.jsx` as needed
3. Install additional dependencies with `npm install package-name`
4. Modify styles in the CSS files

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally
- `npm run lint` - Run ESLint
- `npm run deploy` - Deploy to GitHub Pages

## Technologies Used

- React 18
- Vite
- React Router DOM
- ESLint
- GitHub Pages (gh-pages)
