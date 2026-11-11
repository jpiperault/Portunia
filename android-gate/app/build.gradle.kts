import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Même version que Portunia (package.json) ; code de version croissant : 0.91.0 → 91000.
val portuniaVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val versionParts = portuniaVersion.split(".").map { it.toInt() }

// Clé de signature : android-gate/signature.properties (jamais commité), sinon clé de débogage.
val signing = Properties().apply {
    val f = rootProject.file("signature.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "fr.portunia.gate"
    compileSdk = 35

    defaultConfig {
        applicationId = "fr.portunia.gate"
        minSdk = 26
        targetSdk = 35
        versionName = portuniaVersion
        versionCode = versionParts[0] * 1_000_000 + versionParts[1] * 1_000 + versionParts[2]
    }

    signingConfigs {
        if (signing.containsKey("storeFile")) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("password")
                keyAlias = signing.getProperty("alias")
                keyPassword = signing.getProperty("password")
                storeType = "pkcs12"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
