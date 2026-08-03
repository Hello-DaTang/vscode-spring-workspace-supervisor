import assert from 'node:assert/strict';
import test from 'node:test';
import {
    containsSpringRuntimeClasspath,
    extractMavenArtifactId,
    isAggregatorPom,
    isSpringBuildText,
    parseSpringBootMainClass,
} from '../detection';
import { isEndpointPathQuery, matchesEndpointSymbol } from '../endpointQuery';

test('detects Spring Boot build markers', () => {
    assert.equal(isSpringBuildText('<artifactId>spring-boot-starter-web</artifactId>'), true);
    assert.equal(isSpringBuildText("plugins { id 'org.springframework.boot' version '3.5.0' }"), true);
    assert.equal(isSpringBuildText('<artifactId>jackson-databind</artifactId>'), false);
});

test('recognizes Maven aggregator projects', () => {
    assert.equal(isAggregatorPom('<packaging> pom </packaging>'), true);
    assert.equal(isAggregatorPom('<packaging>jar</packaging>'), false);
});

test('extracts the project artifact id instead of the parent artifact id', () => {
    const pom = `
        <project>
          <parent><groupId>x</groupId><artifactId>parent-platform</artifactId></parent>
          <artifactId>workhour-server</artifactId>
        </project>`;
    assert.equal(extractMavenArtifactId(pom), 'workhour-server');
});

test('parses a fully qualified Spring Boot main class', () => {
    const source = `
        package com.example.gateway;
        import org.springframework.boot.autoconfigure.SpringBootApplication;
        @SpringBootApplication
        public final class GatewayApplication {
            public static void main(String[] args) {}
        }`;
    assert.deepEqual(parseSpringBootMainClass(source), {
        className: 'GatewayApplication',
        packageName: 'com.example.gateway',
        fullyQualifiedName: 'com.example.gateway.GatewayApplication',
    });
});

test('verifies Spring dependencies in Windows and Unix classpaths', () => {
    assert.equal(containsSpringRuntimeClasspath([
        'C:\\Users\\demo\\.m2\\repository\\org\\springframework\\boot\\spring-boot-3.5.0.jar',
    ]), true);
    assert.equal(containsSpringRuntimeClasspath([
        '/home/demo/.m2/repository/org/example/plain-library-1.0.jar',
    ]), false);
});

test('recognizes slash-based endpoint workspace symbol queries', () => {
    assert.equal(isEndpointPathQuery('/admin-api/system/users'), true);
    assert.equal(isEndpointPathQuery('GET /admin-api/system/users'), true);
    assert.equal(isEndpointPathQuery('SystemController'), false);
});

test('matches endpoint symbols while preserving slash input', () => {
    assert.equal(
        matchesEndpointSymbol('/admin-api/system/users', 'GET /admin-api/system/users', 'UserController'),
        true,
    );
    assert.equal(
        matchesEndpointSymbol('/system/users', 'GET admin-api/system/users', 'UserController'),
        true,
    );
    assert.equal(
        matchesEndpointSymbol('/trade/orders', 'GET /system/users', 'UserController'),
        false,
    );
});
