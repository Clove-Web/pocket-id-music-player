// Standalone Gradle build for the native Android app. It is intentionally NOT
// wired into the Tauri desktop project under apps/desktop — this is a separate
// artifact with its own release workflow (.github/workflows/android.yml).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "DoughminationMusic"
include(":app")
