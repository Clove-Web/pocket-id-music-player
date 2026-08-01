import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing is driven by a `keystore.properties` at the module root,
// written from CI secrets (see .github/workflows/android.yml) — the same
// ANDROID_KEY_* secrets the Tauri release workflow already uses. When the file
// is absent (local dev), release falls back to the debug key so a plain
// `assembleRelease` still succeeds instead of failing to sign.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val hasReleaseKeystore = keystorePropertiesFile.exists()

android {
    namespace = "uk.doughmination.music"
    compileSdk = 35

    defaultConfig {
        applicationId = "uk.doughmination.music"
        minSdk = 26
        targetSdk = 35
        // Overridable from CI: -PversionName=1.2.0 -PversionCode=42
        versionCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "1.0.0"

        // The site the WebView loads. Overridable per build via
        //   -PsiteUrl=https://staging.example.com
        val siteUrl = (project.findProperty("siteUrl") as String?) ?: "https://doughmination.me"
        buildConfigField("String", "SITE_URL", "\"$siteUrl\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                val props = Properties().apply { load(FileInputStream(keystorePropertiesFile)) }
                keyAlias = props["keyAlias"] as String
                keyPassword = props["password"] as String
                storeFile = file(props["storeFile"] as String)
                storePassword = props["password"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    val media3 = "1.4.1"

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")

    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-session:$media3")
    implementation("androidx.media3:media3-datasource:$media3")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.google.guava:guava:33.2.1-android")
}
